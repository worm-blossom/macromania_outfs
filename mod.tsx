import {
  EmptyDir,
  EnsureDir,
  Expressions,
  expressions,
  Remove,
  Symlink as FsSymlink,
  WriteTextFile,
} from "./deps.ts";
import {
  Colors,
  Context,
  createSubstate,
  DebuggingInformation,
  existsSync,
  Expression,
  join,
  styleDebuggingInformation,
} from "./deps.ts";

/**
 * The outfs macros an in-memory hierarchy of paths, the *OutFs*.
 * Each Node in the OutFS is a directory, a leaf file (we do not store the
 * contents in memory), or a symlink.
 * For each node, we track the macro that created it for debugging purposes.
 */
type OutFsNode = {
  source: DebuggingInformation;
  node: OutFsNode_;
};

type OutFsNode_ =
  | OutFile
  | OutDir
  | OutSymlink;

/**
 * We store no data with files in the OutFs, we merrely track their existence.
 */
type OutFile = null;
function isOutFile(n: OutFsNode_): n is OutFile {
  return n === null;
}

/**
 * A directory is a collection of OutFsNodes, each with a name.
 */
type OutDir = Map<string, OutFsNode>;
function isOutDir(n: OutFsNode_): n is OutDir {
  return !(isOutFile(n) || isOutSymlink(n));
}

/**
 * A symlink is represented by an absolute path from the root to its source.
 */
type OutSymlink = string[];
function isOutSymlink(n: OutFsNode_): n is OutSymlink {
  return Array.isArray(n);
}

/**
 * The macros further maintain a notion of a cwd in the OutFs. The cwd and the
 * OutFs together form the *OutShell*.
 */
type OutShell = {
  root: OutDir;
  cwd: string[];
};

/**
 * A path in the OutFS.
 */
export type OutFsPath = {
  /**
   * `-1` for an absolute path, otherwise the number of `..` at the start of
   * the path.
   */
  relativity: number;
  /**
   * The path components.
   */
  components: string[];
};

/**
 * Renders an {@linkcode OutFsPath} into a unix-style path string.
 *
 * Some examples:
 *
 * - `{relativity: 0, components ["foo", "bar"]}` becomes `"foo/bar"`
 * - `{relativity: -1, components ["foo", "bar"]}` becomes `"/foo/bar"`
 * - `{relativity: 2, components ["foo"]}` becomes `"../../foo"`
 * - `{relativity: 0, components []}` becomes `"."`
 */
export function renderOutFsPath(p: OutFsPath): string {
  if (p.relativity === 0 && p.components.length === 0) {
    return ".";
  }

  const dots: string[] = new Array(p.relativity);
  dots.fill("..");
  const parents = dots.join("/");

  const prefix = p.relativity === -1 ? "/" : parents;
  return `${prefix}${p.components.length > 0 ? "/" : ""}${
    p.components.join("/")
  }`;
}

/**
 * Like {@linkcode renderOutFsPath}, but with ansi escape styling for terminal
 * output.
 */
export function styleOutFsPath(p: OutFsPath): string {
  return Colors.cyan(renderOutFsPath(p));
}

/**
 * Clone an {@linkcode OutFsPath} into a completely separate object.
 */
export function cloneOutFsPath(p: OutFsPath): OutFsPath {
  return {
    relativity: p.relativity,
    components: [...p.components],
  };
}

function singletonPath(component: string): OutFsPath {
  return { relativity: 0, components: [component] };
}

/**
 * The substate for this family of macros.
 */
type OutFS = {
  /**
   * A directory hierarchy and a cwd in that hierarchy.
   */
  shell: OutShell;
  /**
   * The (platform-dependent) path to where the roor PretendDir is "mounted" in
   * the real file system.
   * Set to the cwd when this file gets loaded, and never changed again.
   */
  mount: string;
};

const [getState, _setState] = createSubstate<OutFS>("OutFS", {
  shell: {
    root: new Map(),
    cwd: [],
  },
  mount: Deno.cwd(),
});

/**
 * Get the current out directory as an `OutFsPath`.
 *
 * The returned path is always an absolute path (i.e., its `relatvity` is -1).
 */
export function outFsCwd(ctx: Context): OutFsPath {
  return {
    relativity: -1,
    components: [...getState(ctx).shell.cwd],
  };
}

/**
 * Change the current out directory for the children of this macro.
 *
 * @param path - An {@linkcode OutFsPath} to resolve from the current out
 * directory.
 * @param create - Whether to create missing parent directories (`true`) or
 * error on missing parent directories (`false`). Defaults to `false`.
 * @param children - Expressions to evaluate in a changed current out
 * directory.
 * @returns The evaluated children.
 */
export function Cd({ children: children_, path: path_, create = false }: {
  path: OutFsPath;
  create?: boolean;
  children?: Expressions;
}): Expression {
  const children = expressions(children_);
  const path = cloneOutFsPath(path_);

  // Some state to let `pre` and `post` cooperate in changing the current
  // out dir and later undoing the change.
  let priorOutDirectory: string[] = [];

  // Reset the current out dir to what they where before this macro.
  const post = (ctx: Context) => {
    const state = getState(ctx);
    state.shell.cwd = priorOutDirectory;
  };

  // Remember the prior out dir to the current one, then update the
  // actual state to the new ones.
  const pre = (ctx: Context) => {
    const initialCwd = outFsCwd(ctx);
    const shell = getState(ctx).shell;
    // Remember the old cwd.
    priorOutDirectory = shell.cwd;

    /* Now we set the new cwd */

    if (path.relativity === -1) {
      // We cd to an absolute path by setting the cwd to the root directory
      // and then treating the path like a relative one.
      shell.cwd = [];
      path.relativity = 0;
    }

    // Move upwards for any `..`.
    while (path.relativity > 0) {
      path.relativity -= 1;

      if (shell.cwd.length > 0) {
        shell.cwd.pop();
      } else {
        const dotdot = styleOutFsPath({ relativity: 1, components: [] });
        logResolveFailure(ctx, path_, initialCwd);
        ctx.error(
          `  Reached the root of the out fs after processing ${
            path_.relativity - path.relativity
          } many ${dotdot}`,
        );
        ctx.error(
          `  But the remaining path has ${path.relativity} more ${dotdot}:`,
        );
        ctx.error(`  ${styleOutFsPath(path)}`);
        return ctx.halt();
      }
    }

    // Done processing the `..`, can concat the path components to the cwd.
    shell.cwd = shell.cwd.concat(path.components);

    // Trigger an error if the resulting cwd is invalid for any reason.
    const node = resolveCwd(ctx, create, path_, initialCwd);
    const _ = ensureOutNodeIsDir(ctx, node, path_, initialCwd, outFsCwd(ctx));
  };

  return <lifecycle pre={pre} post={post}>{children}</lifecycle>;
}

function logResolveFailure(ctx: Context, path: OutFsPath, from: OutFsPath) {
  ctx.error(`Failed to resolve OutFsPath to a directory.`);
  ctx.error(`  path: ${styleOutFsPath(path)}`);
  ctx.error(`  from out_pwd: ${styleOutFsPath(from)}`);
}

/**
 * Internal function: resolves the pwd of the shell to an OutFsNode. Halts if
 * impossible.
 * @param ctx - The context whose shell should be resolved to a node.
 * @param create - Whether to create missing parent directories (`true`) or
 * error on missing parent directories (`false`).
 * @param path - The path to originally resolve, for better error messages.
 * @param from - The path from where to originally resolve, for better error
 * messages.
 */
function resolveCwd(
  ctx: Context,
  create: boolean,
  path: OutFsPath,
  from: OutFsPath,
): OutFsNode {
  const shell = getState(ctx).shell;

  const startPath = [...shell.cwd];

  // We resolve the path by iteratively resolving the first path component.
  let currentPath = [...startPath];
  // The components that have already been resolved.
  // The algorithm maintains concat(resolved, currentPath) == shell.cwd
  let resolved: string[] = [];
  // While resolving the path, this variable stores the successive directories.
  let currentNode: OutFsNode = { source: {}, node: shell.root };

  while (currentPath.length > 0) {
    const [fst, ...rest] = currentPath;

    if (isOutFile(currentNode.node)) {
      // We have reached a leaf file, yet the path still has more components.
      // Time to error out.
      logResolveFailure(ctx, path, from);
      ctx.error(
        `  ${
          styleOutFsPath({ relativity: -1, components: currentPath })
        } is not a directory.`,
      );
      ctx.error(
        `  The non-directory was created at ${
          styleDebuggingInformation(currentNode.source)
        }`,
      );
      ctx.halt();
      throw "just halted";
    }

    if (isOutSymlink(currentNode.node)) {
      // We are dealing with a symlink. Simply replace the cwd up to the
      // symlink with its target, and recursively attempt resolving again.
      shell.cwd = [...currentNode.node, ...rest];
      return resolveCwd(ctx, create, path, from);
    }

    // Neither leaf file nor symlink, so we are in a directory.
    // Look up the next path component.
    let nextNode = currentNode.node.get(fst);
    if (nextNode === undefined) {
      // Path component not found. Should we create the directory?
      if (create) {
        // Yes, create the directory and act like it always was there.
        nextNode = {
          source: ctx.getCurrentDebuggingInformation(),
          node: new Map(),
        };
        currentNode.node.set(fst, nextNode);
      } else {
        // No, error instad of creating missing components.
        logResolveFailure(ctx, path, from);
        ctx.error(
          `  no file ${styleOutFsPath(singletonPath(fst))} in ${resolved}`,
        );
        ctx.halt();
        throw "just halted";
      }
    }

    // Successfully looked up the directory, so we successfully handled the
    // first path component. Continue the loop with the next component.
    currentPath = rest;
    resolved = [...resolved, fst];
    currentNode = nextNode;
  }

  return currentNode;
}

/**
 * Error if the given node is not a directory.
 */
function ensureOutNodeIsDir(
  ctx: Context,
  node: OutFsNode,
  path: OutFsPath,
  from: OutFsPath,
  resolved: OutFsPath,
): OutDir {
  if (isOutDir(node.node)) {
    return node.node;
  } else {
    logResolveFailure(ctx, path, from);
    ctx.error(`  The path resolved not to a directory but to a file:`);
    ctx.error(`  ${styleOutFsPath(resolved)}`);
    ctx.error(`  File created at ${styleDebuggingInformation(node.source)}`);
    ctx.halt();
    throw "just halted";
  }
}

/**
 * To be used when somethings requires path arguments for error reporting
 * but we know it cannot fail.
 */
const dummyPath: OutFsPath = {
  relativity: 0,
  components: [],
};

/**
 * Create a directory in the current out directory, and `cd` there.
 *
 * @param name - The name of the directory to create.
 * @param mode - What to do if there is already a file at this name.
 *   - `"timid"`: Log error and halt. The default if unspecified.
 *   - `"placid"`: Do nothing if there is already a file/directory of this name.
 *   - `"assertive"`: Create a new empty directory at this name, no matter what.
 * @param children - Expressions to evaluate in the new directory.
 * @returns The evaluated children.
 */
export function Dir({ name, children: children_, mode = "timid" }: {
  name: string;
  mode?: "timid" | "placid" | "assertive";
  children?: Expressions;
}): Expression {
  const children = expressions(children_);

  // First, create the directory both in the OutFS and on the real fs.
  const createTheDir = (
    <impure
      fun={(ctx: Context) => {
        const state = getState(ctx);

        // Get the current directory (cannot fail).
        const node = resolveCwd(ctx, false, dummyPath, dummyPath);
        const outDir = ensureOutNodeIsDir(
          ctx,
          node,
          dummyPath,
          dummyPath,
          outFsCwd(ctx),
        );

        let createNewDir = true;

        // Add a new directory to the current directory.
        if (outDir.has(name)) {
          // We already have a node at this name.

          if (mode === "timid") {
            // Immediately error out.
            ctx.error(
              `Cannot create ${styleOutFsPath(singletonPath(name))} in ${
                styleOutFsPath(outFsCwd(ctx))
              }`,
            );
            ctx.error(
              `  File ${styleOutFsPath(singletonPath(name))} already exists.`,
            );
            ctx.error(
              `  Created at ${
                styleDebuggingInformation(outDir.get(name)!.source)
              }`,
            );
            return ctx.halt();
          } else if (mode === "placid") {
            createNewDir = false;
          } else {
            // We are "assertive", so no need adjust our behavior.
          }
        }

        if (createNewDir) {
          // Time to create an empty directory:
          // in the logical OutFs...
          outDir.set(name, {
            source: ctx.getCurrentDebuggingInformation(),
            node: new Map(),
          });
          // ... and on the real file system.
          return <EmptyDir dir={join(state.mount, ...state.shell.cwd, name)} />;
        } else {
          return (
            <EnsureDir dir={join(state.mount, ...state.shell.cwd, name)}>
            </EnsureDir>
          );
        }
      }}
    />
  );

  return (
    <map
      fun={(_: string, _ctx: Context) => {
        return <Cd path={singletonPath(name)}>{children}</Cd>;
      }}
    >
      {createTheDir}
    </map>
  );
}

/**
 * Create a file in current out directory, write the evaluated children there.
 *
 * @param name - The name of the file to create.
 * @param mode - What to do if there is already a file at this name.
 *   - `"timid"`: Log error and halt. The default if unspecified.
 *   - `"placid"`: Do nothing if there is already a file/directory of this name.
 *   - `"assertive"`: Overwrite whatever came before.
 * @param children - Expressions to evaluate to form the file contents.
 * @returns The evaluated children.
 */
export function File({ name, children: children_, mode = "timid" }: {
  name: string;
  mode?: "timid" | "placid" | "assertive";
  children?: Expressions;
}): Expression {
  const children = expressions(children_);

  let createNewFile = true;

  // First, create the file in the OutFS.
  const createTheFile = (
    <impure
      fun={(ctx: Context) => {
        const state = getState(ctx);

        // Get the current directory (cannot fail).
        const node = resolveCwd(ctx, false, dummyPath, dummyPath);
        const outDir = ensureOutNodeIsDir(
          ctx,
          node,
          dummyPath,
          dummyPath,
          outFsCwd(ctx),
        );

        // Add the file to the current directory.
        if (outDir.has(name)) {
          // We already have a node at this name.

          if (mode === "timid") {
            // Immediately error out.
            ctx.error(
              `Cannot create ${styleOutFsPath(singletonPath(name))} in ${
                styleOutFsPath(outFsCwd(ctx))
              }`,
            );
            ctx.error(
              `  File ${styleOutFsPath(singletonPath(name))} already exists.`,
            );
            ctx.error(
              `  Created at ${
                styleDebuggingInformation(outDir.get(name)!.source)
              }`,
            );
            return ctx.halt();
          } else if (mode === "placid") {
            createNewFile = false;
          } else {
            // We are "assertive", so no need adjust our behavior.
          }
        }

        if (createNewFile) {
          // Create the file in the logical OutFs.
          outDir.set(name, {
            source: ctx.getCurrentDebuggingInformation(),
            node: null,
          });
          // Delete any prior version of the file from the real fs.
          return <Remove path={join(state.mount, ...state.shell.cwd, name)} />;
        } else {
          return children;
        }
      }}
    />
  );

  return (
    <map
      fun={(evaled: string, ctx: Context) => {
        if (createNewFile) {
          const state = getState(ctx);
          return (
            <WriteTextFile path={join(state.mount, ...state.shell.cwd, name)}>
              {evaled}
            </WriteTextFile>
          );
        } else {
          return evaled;
        }
      }}
    >
      {createTheFile}
    </map>
  );
}

/**
 * Create a file in current out directory, write the evaluated children there.
 *
 * @param newname - name of the symlink in the current out directory.
 * @param oldpath - Path in the current out directory to which the simlink
 * should point.
 * @param mode - What to do if there is already a file at this name.
 *   - `"timid"`: Log error and halt. The default if unspecified.
 *   - `"placid"`: Do nothing if there is already a file/directory of this name.
 *   - `"assertive"`: Overwrite whatever came before.
 * @returns The empty string.
 */
export function Symlink({ newname, oldpath, mode = "timid" }: {
  newname: string;
  oldpath: OutFsPath;
  mode?: "timid" | "placid" | "assertive";
}): Expression {
  let createNewSymlink = true;
  let resolvedOldPath = dummyPath;

  // First, create the symlink in the OutFS.
  const createTheSymlink = (
    <impure
      fun={(ctx: Context) => {
        const state = getState(ctx);

        // Get the current directory (cannot fail).
        const node = resolveCwd(ctx, false, dummyPath, dummyPath);
        const outDir = ensureOutNodeIsDir(
          ctx,
          node,
          dummyPath,
          dummyPath,
          outFsCwd(ctx),
        );

        // Add the file to the current directory.
        if (outDir.has(newname)) {
          // We already have a node at this name.

          if (mode === "timid") {
            // Immediately error out.
            ctx.error(
              `Cannot create ${styleOutFsPath(singletonPath(newname))} in ${
                styleOutFsPath(outFsCwd(ctx))
              }`,
            );
            ctx.error(
              `  File ${
                styleOutFsPath(singletonPath(newname))
              } already exists.`,
            );
            ctx.error(
              `  Created at ${
                styleDebuggingInformation(outDir.get(newname)!.source)
              }`,
            );
            return ctx.halt();
          } else if (mode === "placid") {
            createNewSymlink = false;
          } else {
            // We are "assertive", so no need adjust our behavior.
          }
        }

        if (createNewSymlink) {
          // Create the file in the logical OutFs.
          outDir.set(newname, {
            source: ctx.getCurrentDebuggingInformation(),
            node: 42,
          });
          // Delete any prior version of the file from the real fs.
          return (
            <Remove path={join(state.mount, ...state.shell.cwd, newname)} />
          );
        } else {
          return "";
        }
      }}
    />
  );

  return (
    <map
      fun={(_evaled: string, _ctx: Context) => {
        if (createNewSymlink) {
          return (
            <impure
              fun={(ctx: Context) => {
                const state = getState(ctx);

                // Create in the real fs once its oldpath exists there.
                if (
                  existsSync(join(state.mount, ...resolvedOldPath.components))
                ) {
                  return (
                    <FsSymlink
                      newpath={join(state.mount, ...state.shell.cwd, newname)}
                      oldpath={join(state.mount, ...resolvedOldPath.components)}
                    />
                  );
                } else {
                  return null;
                }
              }}
            />
          );
        } else {
          return "";
        }
      }}
    >
      {createTheSymlink}
    </map>
  );
}

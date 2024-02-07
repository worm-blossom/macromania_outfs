import {
  absoluteOutFsPath,
  Cd,
  Dir,
  File,
  relativeOutFsPath,
} from "../mod.tsx";
import { Context, Expression, Expressions, expressions } from "../deps.ts";
import { assertEquals } from "../devDeps.ts";
import { join } from "../deps.ts";

type ExpectedNode = ExpectedDir | string;

type ExpectedDir = {
  name: string;
  node: ExpectedNode;
}[];

function assertFsNode(path: string, expected: ExpectedNode, del = true) {
  if (typeof expected === "string") {
    assertEquals(Deno.readTextFileSync(path), expected);
    if (del) {
      Deno.removeSync(path);
    }
  } else {
    assertEquals(Deno.statSync(path).isDirectory, true);
    for (const node of expected) {
      assertFsNode(join(path, node.name), node.node, del);
    }
    Deno.removeSync(path);
  }
}

function cleanup(path: string) {
  Deno.removeSync(path, {recursive: true});
}

Deno.test("basic usage", () => {
  const ctx = new Context();
  const got = ctx.evaluate(
    <Dir name="recipes">
      <File name="index.md">These are good recipes.</File>
      <Dir name="dessert">
        <File name="chocolate_cake.md">
          Mix chocolate and cake, serve in bowl.
        </File>
        <File name="icecream.md">
          Put cream into freezer, then eat quickly.
        </File>
      </Dir>
    </Dir>,
  );
  assertEquals(got != null, true);

  const expected = [
    { name: "index.md", node: `These are good recipes.` },
    {
      name: "dessert",
      node: [
        {
          name: "chocolate_cake.md",
          node: "Mix chocolate and cake, serve in bowl.",
        },
        {
          name: "icecream.md",
          node: "Put cream into freezer, then eat quickly.",
        },
      ],
    },
  ];
  assertFsNode("recipes", expected);
});

Deno.test("cd usage", () => {
  const ctx = new Context();
  const got = ctx.evaluate(
    <Dir name="recipes">
      <Dir name="dessert">
        {/* without the `create` flag it would not create the dir but error*/}
        <Cd path={absoluteOutFsPath(["recipes", "breakfast"])} create>
          <File name="breadrolls.md">
            Buy bread, roll on the floor for 48 hours.
          </File>
        </Cd>
        {/* The number gives the number of ".." at the start of the path.*/}
        <Cd path={relativeOutFsPath(["breakfast"], 1)}>
          <File name="cereals.md">
            If you need a recipe, you are doing it wrong.
          </File>
        </Cd>
        <File name="icecream.md">
          Put cream into freezer, then eat quickly.
        </File>
      </Dir>
    </Dir>,
  );
  assertEquals(got != null, true);

  const expected = [
    {
      name: "dessert",
      node: [
        {
          name: "icecream.md",
          node: "Put cream into freezer, then eat quickly.",
        },
      ],
    },
    {
      name: "breakfast",
      node: [
        {
          name: "breadrolls.md",
          node: "Buy bread, roll on the floor for 48 hours.",
        },

        {
          name: "cereals.md",
          node: "If you need a recipe, you are doing it wrong.",
        },
      ],
    },
  ];
  assertFsNode("recipes", expected);
});

Deno.test("cd non-creative", () => {
  const ctx = new Context();
  const got = ctx.evaluate(
    <Cd path={relativeOutFsPath(["foo"])}></Cd>,
  );
  assertEquals(got === null, true);
  assertEquals(ctx.didWarnOrWorse(), true);
});

Deno.test("cd out of root", () => {
  const ctx = new Context();
  const got = ctx.evaluate(
    <Cd path={relativeOutFsPath(["foo"], 1)}></Cd>,
  );
  assertEquals(got === null, true);
  assertEquals(ctx.didWarnOrWorse(), true);
});

Deno.test("file assertive", () => {
  const ctx = new Context();
  const got = ctx.evaluate(
    <Dir name="a">
      <File name="b">x</File>
      <File name="b" mode="assertive">y</File>
    </Dir>,
  );
  assertEquals(got != null, true);

  const expected = [
    { name: "b", node: `y` },
  ];
  assertFsNode("a", expected);
});

Deno.test("file placid", () => {
  const ctx = new Context();
  const got = ctx.evaluate(
    <Dir name="a">
      <File name="b">x</File>
      <File name="b" mode="placid">y</File>
    </Dir>,
  );
  assertEquals(got != null, true);

  const expected = [
    { name: "b", node: `x` },
  ];
  assertFsNode("a", expected);
});

Deno.test("file timid", () => {
  const ctx = new Context();
  const got = ctx.evaluate(
    <Dir name="a">
      <File name="b">x</File>
      <File name="b" mode="timid">y</File>
    </Dir>,
  );
  assertEquals(got === null, true);
  assertEquals(ctx.didWarnOrWorse(), true);
  cleanup("a");
});

Deno.test("file default is timid", () => {
  const ctx = new Context();
  const got = ctx.evaluate(
    <Dir name="a">
      <File name="b">x</File>
      <File name="b">y</File>
    </Dir>,
  );
  assertEquals(got === null, true);
  assertEquals(ctx.didWarnOrWorse(), true);
  cleanup("a");
});

Deno.test("dir assertive", () => {
  const ctx = new Context();
  const got = ctx.evaluate(
    <Dir name="a">
      <Dir name="b">
        <File name="c">x</File>
      </Dir>
      <Dir name="b" mode="assertive">
        <File name="c">y</File>
      </Dir>
    </Dir>,
  );
  assertEquals(got != null, true);

  const expected = [
    {
      name: "b",
      node: [
        { name: "c", node: `y` },
      ],
    },
  ];
  assertFsNode("a", expected);
});

Deno.test("dir placid 1", () => {
  const ctx = new Context();
  const got = ctx.evaluate(
    <Dir name="a">
      <Dir name="b">
        <File name="c">x</File>
      </Dir>
      <Dir name="b" mode="placid">
        <File name="c" mode="assertive">y</File>
      </Dir>
    </Dir>,
  );
  assertEquals(got != null, true);

  const expected = [
    {
      name: "b",
      node: [
        { name: "c", node: `y` },
      ],
    },
  ];
  assertFsNode("a", expected);
});

Deno.test("dir placid 2", () => {
  const ctx = new Context();
  const got = ctx.evaluate(
    <Dir name="a">
      <Dir name="b">
        <File name="c">x</File>
      </Dir>
      <Dir name="b" mode="placid">
        <File name="c">y</File>
      </Dir>
    </Dir>,
  );
  assertEquals(got === null, true);
  assertEquals(ctx.didWarnOrWorse(), true);
  cleanup("a");
});


Deno.test("dir timid", () => {
  const ctx = new Context();
  const got = ctx.evaluate(
    <Dir name="a">
      <Dir name="b">
        <File name="c">x</File>
      </Dir>
      <Dir name="b" mode="timid"></Dir>
    </Dir>,
  );
  assertEquals(got === null, true);
  assertEquals(ctx.didWarnOrWorse(), true);
  cleanup("a");
});

Deno.test("dir default is timid", () => {
  const ctx = new Context();
  const got = ctx.evaluate(
    <Dir name="a">
      <Dir name="b">
        <File name="c">x</File>
      </Dir>
      <Dir name="b"></Dir>
    </Dir>,
  );
  assertEquals(got === null, true);
  assertEquals(ctx.didWarnOrWorse(), true);
  cleanup("a");
});

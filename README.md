# Macromania OutFS

Macros for [Macromania](https://github.com/worm-blossom/macromania) to describe
output directory structures via nested macros:

```tsx
<Dir name="recipes">
  <File name="index.md">These are good recipes.</File>
  <Dir name="dessert">
    <File name="chocolate_cake.md">Mix chocolate and cake, serve in bowl.</File>
    <File name="ice_cream.md">Put cream into freezer, then eat quickly.</File>
  </Dir>
</Dir>;
```

Creates a directory hierarchy (in the real file system, rooted at the current
working directory of the process):

```
- recipes
    - index.md
    - dessert
        - chocolate_cake.md
        - ice_cream.md
```

The macros also track the directory hierarchy internally. You can use relative
and absolute paths to specify where to create files. Missing directories are
crated automatically. Use `/` as a path separator.

```tsx
<Dir name="recipes">
  <Dir name="dessert">
    <File name="breadrolls.md" path="../breakfast">
      Buy bread, roll on the floor for 48 hours.
    </File>
    <File name="cereals.md" path="/recipes/breakfast">
      If you need to ask, you are doing it wrong.
    </File>
  </Dir>
</Dir>;
```

```
- recipes
    - dessert
    - breakfast
        - breadrolls.md
        - cereals.md
```

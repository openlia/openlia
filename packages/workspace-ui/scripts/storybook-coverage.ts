import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "../src/client");
const exports = new Set<string>();
const covered = new Set<string>();
for (const path of readdirSync(root, { recursive: true })
  .map(String)
  .filter((path) => path.endsWith(".tsx") && !path.includes(".test."))) {
  const source = ts.createSourceFile(
    path,
    readFileSync(resolve(root, path), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  if (path.endsWith(".stories.tsx")) {
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(source) === "componentExports" &&
        ts.isArrayLiteralExpression(node.initializer)
      ) {
        for (const item of node.initializer.elements)
          if (ts.isStringLiteral(item)) covered.add(item.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    continue;
  }
  if (path.startsWith("stories/")) continue;
  for (const node of source.statements) {
    if (
      !ts.canHaveModifiers(node) ||
      !ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    )
      continue;
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name &&
      /^[A-Z]/.test(node.name.text)
    ) {
      exports.add(`${path}#${node.name.text}`);
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          ts.isCallExpression(declaration.initializer) &&
          declaration.initializer.expression.getText(source) ===
            "defineComponent"
        ) {
          exports.add(`${path}#${declaration.name.text}`);
        }
      }
    }
  }
}
const missing = [...exports].filter((name) => !covered.has(name)).sort();
const stale = [...covered].filter((name) => !exports.has(name)).sort();
console.log(
  `Storybook coverage: ${exports.size - missing.length}/${exports.size} exported UI components have declared stories.`,
);
if (missing.length) console.error(`Missing stories:\n${missing.join("\n")}`);
if (stale.length)
  console.error(`Stale story declarations:\n${stale.join("\n")}`);
if (missing.length || stale.length) process.exitCode = 1;

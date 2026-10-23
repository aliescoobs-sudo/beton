import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// AC-LED-11: no `+ - * / %` on a `Centimes` value outside src/lib/money.ts (use addCentimes, subCentimes, sumCentimes,
// negateCentimes, mulDivRound). Decided by the type checker: an operand whose type carries the Centimes brand.
const ARITHMETIC = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
]);

const isCentimes = (checker: ts.TypeChecker, node: ts.Node) => {
  const type = checker.getTypeAtLocation(node);
  const parts = type.isIntersection() ? type.types : [type];
  return (
    parts.some((t) => t.getProperty('__brand') !== undefined) &&
    checker.typeToString(type).includes('Centimes')
  );
};

function violations(program: ts.Program, skip: (file: string) => boolean): string[] {
  const checker = program.getTypeChecker();
  const found: string[] = [];
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || skip(file.fileName)) continue;
    const visit = (node: ts.Node) => {
      if (ts.isBinaryExpression(node) && ARITHMETIC.has(node.operatorToken.kind)) {
        if (isCentimes(checker, node.left) || isCentimes(checker, node.right)) {
          const { line } = file.getLineAndCharacterOfPosition(node.getStart());
          found.push(`${file.fileName}:${line + 1}: ${node.getText()}`);
        }
      } else if (
        (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) ||
        (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.PlusToken)
      ) {
        if (isCentimes(checker, node.operand)) {
          const { line } = file.getLineAndCharacterOfPosition(node.getStart());
          found.push(`${file.fileName}:${line + 1}: ${node.getText()}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found;
}

function programOf(files: Record<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    noLib: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) =>
    name in files ? ts.createSourceFile(name, files[name] as string, lang) : original(name, lang, ...rest);
  host.fileExists = (name) => name in files;
  host.readFile = (name) => files[name];
  return ts.createProgram(Object.keys(files), options, host);
}

const PRELUDE = `
interface Number {} interface Boolean {} interface String {} interface Object {} interface Function {}
interface Array<T> {} interface IArguments {} interface RegExp {} interface CallableFunction {} interface NewableFunction {}
type Centimes = number & { readonly __brand: 'Centimes' };
declare const a: Centimes; declare const b: Centimes; declare const n: number;
`;

describe('the Centimes arithmetic scan (AC-LED-11)', () => {
  it('flags + - * / and compound assignment on Centimes, and ignores plain numbers', () => {
    const program = programOf({
      'probe.ts': `${PRELUDE}
        export const bad1 = a + b; export const bad2 = a - 1; export const bad3 = a * 2; export const bad4 = n / a;
        let t = a; t += b; export const bad5 = -a;
        export const ok1 = n + 1; export const ok2 = n * n; export const ok3 = a > b; export const ok4 = a === b;`,
    });
    const found = violations(program, () => false);
    expect(found).toHaveLength(6);
    expect(found.join('\n')).not.toMatch(/ok\d/);
  });

  it('finds none in the source tree outside src/lib/money.ts', () => {
    const configPath = ts.findConfigFile('.', ts.sys.fileExists, 'tsconfig.json') as string;
    const config = ts.getParsedCommandLineOfConfigFile(
      configPath,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (d) => {
          throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
        },
      },
    );
    const program = ts.createProgram(config?.fileNames ?? [], config?.options ?? {});
    const found = violations(
      program,
      (file) =>
        file.includes('node_modules') || file.endsWith('src/lib/money.ts') || /\.test\.tsx?$/.test(file),
    );
    expect(found).toEqual([]);
  }, 120_000);
});

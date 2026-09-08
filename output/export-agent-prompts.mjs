import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const out = path.join(root, 'output/agent-prompts-20260908');
fs.mkdirSync(out, { recursive: true });
function source(file) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}
function find(tree, predicate) {
  let result;
  function visit(node) { if (!result && predicate(node)) result = node; if (!result) ts.forEachChild(node, visit); }
  visit(tree);
  if (!result) throw new Error('Prompt node not found in ' + tree.fileName);
  return result;
}
const named = (tree, name) => find(tree, n => (ts.isVariableDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name?.getText(tree) === name);
const literal = node => {
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) throw new Error('Expected static text');
  return node.text;
};
const fence = (text, language = 'text') => '\n```' + language + '\n' + text + '\n```\n';
const code = (tree, node) => `\nSource: ${tree.fileName}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}\n` + fence(node.getText(tree), 'typescript');
function promptArray(tree, method) {
  const node = named(tree, method);
  const prop = find(node, n => ts.isPropertyAssignment(n) && n.name.getText(tree) === 'text' && ts.isCallExpression(n.initializer) && ts.isPropertyAccessExpression(n.initializer.expression) && n.initializer.expression.name.text === 'join');
  return find(prop.initializer, ts.isArrayLiteralExpression);
}
function arrayText(tree, array) {
  return array.elements.map(e => ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)
    ? e.text : '[DYNAMIC TEMPLATE: ' + e.getText(tree) + ']').join('\n\n');
}
const cp = source('apps/api/src/codex-provider.ts');
const hp = source('apps/api/src/http-providers.ts');
const ep = source('apps/api/src/experimental-tools.ts');
const er = source('apps/api/src/experiment-runtime.ts');
const it = source('apps/api/src/experiment-iterative.ts');
const main = literal(named(cp, 'mainAgentInstructions').initializer);
const photo = literal(named(ep, 'photoAgentInstructions').initializer);
fs.writeFileSync(path.join(out, 'main.txt'), main + '\n' + photo + '\n');
let md = '# AVO application prompt export\n\n';
md += 'Extracted from the current checkout on 2026-09-08. These are AVO-owned instructions, not a reconstruction of all Codex built-in instructions or a historical provider request. Static text is verbatim. DYNAMIC TEMPLATE markers retain source expressions instead of inventing runtime values. No credentials or image bytes are included.\n\n';
md += 'Latest reviewed run: run-4c6b66f1-3c86-4516-a192-7ffabb29e178. Main/Verifier/Supervisor: qwen3.8-max. Photo and iterative enabled; SVG and Copilot disabled.\n\n';
md += '## Main: developerInstructions (active configuration)\n' + fence(main + '\n' + photo);
md += '\nThe generated harness AGENTS.md repeats the base Main instructions. The photo addendum is passed through developerInstructions.\n';
md += '## Main: dynamic invocation message\n' + code(cp, named(cp, 'variationStepPrompt'));
md += '## Main: experiment context builders\n' + code(er, named(er, 'experimentPrompt')) + code(it, named(it, 'iterativeContext'));
md += '## Optional SVG addendum (disabled in the reviewed run)\n' + fence(literal(named(ep, 'svgAgentInstructions').initializer));
md += '## Supervisor: developerInstructions\n' + fence('Return only the requested structured result. Do not modify files or call model providers.');
const sup = named(cp, 'supervise');
const prompt = find(sup, n => ts.isVariableDeclaration(n) && n.name.getText(cp) === 'prompt');
const arr = prompt.initializer.expression.expression;
fs.writeFileSync(path.join(out, 'supervisor.txt'), 'developerInstructions:\nReturn only the requested structured result. Do not modify files or call model providers.\n\nRole prompt (DYNAMIC TEMPLATE markers are source expressions):\n' + arrayText(cp, arr) + '\n');
md += '## Supervisor: role prompt and dynamic context\n' + fence(arrayText(cp, arr));
md += '## Supervisor: output contract and exact assembly\n' + code(cp, sup);
md += '## Verifier: Responses instructions\n';
const instructions = find(hp, n => ts.isPropertyAssignment(n) && n.name.getText(hp) === 'instructions' && ts.isStringLiteral(n.initializer));
md += fence(literal(instructions.initializer));
let verifierText = 'Responses instructions:\n' + literal(instructions.initializer) + '\n';
for (const method of ['createEvaluationFrame', 'comparisonPass', 'reviewLineage', 'selectFinal']) {
  const text = arrayText(hp, promptArray(hp, method));
  verifierText += '\n' + method + ' (DYNAMIC TEMPLATE markers are source expressions):\n' + text + '\n';
  md += '## Verifier: ' + method + '\n' + fence(text);
}
md += '## Verifier: consistency-repair instruction\n';
const repair = find(hp, n => ts.isPropertyAssignment(n) && n.name.getText(hp) === 'instruction' && ts.isStringLiteral(n.initializer) && n.initializer.text.startsWith('Resubmit the complete comparison'));
md += fence(literal(repair.initializer));
verifierText += '\nConsistency repair:\n' + literal(repair.initializer) + '\n';
fs.writeFileSync(path.join(out, 'verifier.txt'), verifierText);
md += '## Assembly appendix\nThe following source excerpts show image attachment order, output contracts, history, review passes and validation. They are code, not additional prose system prompts.\n';
for (const method of ['historyContent', 'createEvaluationFrame', 'compare', 'comparisonPass', 'reviewLineage', 'selectFinal']) {
  if (method === 'compare') continue;
  md += code(hp, named(hp, method));
}
md += '\n## Image generator\nGPT Image 2 receives the prompt authored by Main and the selected images. This is a generation request, not a separate planning-agent system prompt.\n';
fs.writeFileSync(path.join(out, 'all-agent-prompts.md'), md);
console.log(JSON.stringify({ output: out, mainCharacters: main.length + photo.length + 1, documentCharacters: md.length }));

import compat from 'eslint-plugin-compat';
import tsParser from '@typescript-eslint/parser';
import { ALLOWLIST, DENYLIST } from './scripts/compat-gate.mjs';
import { focusRules } from './scripts/eslint-focus-rules.mjs';

const entryByKind = new Map(DENYLIST.map((entry) => [entry.kind, entry]));
const callOptions = DENYLIST.filter((entry) => entry.kind === 'call-option');
const polyfilled = new Set(
  ALLOWLIST.filter((entry) => entry.reason === 'polyfilled').map((entry) => entry.name),
);

function expressionName(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type !== 'MemberExpression') return undefined;
  if (node.computed && node.property.type === 'Literal') return node.property.value;
  return !node.computed && node.property.type === 'Identifier' ? node.property.name : undefined;
}

function objectProperty(node, name) {
  if (!node || node.type !== 'ObjectExpression') return undefined;
  return node.properties.find((property) =>
    property.type === 'Property'
    && ((property.key.type === 'Identifier' && property.key.name === name)
      || (property.key.type === 'Literal' && property.key.value === name)));
}

const unsupportedPatterns = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    return {
      NewExpression(node) {
        const name = expressionName(node.callee);
        const type = objectProperty(node.arguments[1], 'type');
        const moduleWorker = entryByKind.get('worker-option');
        if (moduleWorker && (name === 'Worker' || name === 'SharedWorker')
            && type?.value.type === 'Literal'
            && type.value.value === 'module') {
          context.report({ node, message: moduleWorker.message });
        }
      },
      CallExpression(node) {
        const name = expressionName(node.callee);
        for (const option of callOptions) {
          if (name === option.call && objectProperty(node.arguments[option.arg], option.property)) {
            context.report({ node, message: option.message });
          }
        }
      },
    };
  },
};

// Focus handling lives in src/navigation/. The one inline disable left is a
// pointer listener that is not about focus, and it says why; an unused
// disable is an error, so deleting a site must delete its comment.
export const FOCUS_RULE_FILES = {
  files: ['src/**/*.ts'],
  ignores: ['src/**/*.test.ts', 'src/test/**', 'src/navigation/**'],
};
export const FOCUS_RULES = ['no-ring-writer', 'no-raw-pointer-listener', 'no-scroll-into-view'];

// webOS 23 ships Chromium 94, the oldest supported engine. esbuild only
// down-levels *syntax* to that target; it does NOT polyfill missing *APIs*,
// which would silently fail on a real TV. Three rules below close that gap,
// all keyed to the "browserslist" field in package.json (shared with the CSS
// gate) and to MIN_CHROME in scripts/compat-gate.mjs:
//   - compat/compat        — flags missing global/static APIs (structuredClone, …)
//   - no-restricted-syntax — a denylist for prototype methods compat can't see
//   - unsupported-patterns — checks unsupported constructor/call option shapes
export default [
  {
    files: ['src/**/*.ts'],
    plugins: {
      compat,
      'webos-compat': { rules: { 'unsupported-patterns': unsupportedPatterns } },
    },
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'compat/compat': 'error',
      // eslint-plugin-compat catches global/static APIs (structuredClone,
      // Promise.allSettled, …) but NOT prototype *instance* methods, because it
      // can't infer that `arr.flat()` is Array.prototype.flat from the AST. Close
      // that blind spot with a name-based denylist of distinctive post-94 methods.
      // (If a custom object legitimately has one of these names, disable per-line.)
      'no-restricted-syntax': [
        'error',
        ...DENYLIST.filter((e) => e.kind === 'method' && !polyfilled.has(e.name)).map((e) => ({
          selector: `CallExpression > MemberExpression[property.name='${e.name}']`,
          message: e.message,
        })),
        {
          // A raw class write can't see a ring FocusRing parked, so a later
          // return of the keys would show two (see src/navigation/focus-ring.ts).
          selector: "CallExpression[callee.object.property.name='classList'][arguments.0.value='focused']",
          message: "Request the focus ring through a focus scope (navigation/focus-scope).",
        },
      ],
      'webos-compat/unsupported-patterns': 'error',
    },
  },
  {
    // Tests run in Node under vitest, never on the TV's WebView, so the
    // Chromium compatibility gates don't apply to them.
    files: ['src/**/*.test.ts'],
    plugins: { compat },
    rules: {
      'compat/compat': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    ...FOCUS_RULE_FILES,
    plugins: { focus: { rules: focusRules } },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: Object.fromEntries(FOCUS_RULES.map((rule) => [`focus/${rule}`, 'error'])),
  },
];

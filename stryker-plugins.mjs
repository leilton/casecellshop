// Stryker ignorer (ADR 0011): log lines and trace span names/attributes have no behaviour a test should pin
// down, so their mutants are skipped with a reason instead of counting as survivors. Metric labels are NOT
// ignored: they are a contract with infra/prometheus/alerts.yml and must be killed by tests.
import { declareValuePlugin, PluginKind } from '@stryker-mutator/api/plugin';

const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

function isLogCall(node) {
  if (node?.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return false;
  const { object, property } = node.callee;
  if (property.type !== 'Identifier' || !LOG_METHODS.has(property.name)) return false;
  // deps.logger.info(...), logger.warn(...), req.log.error(...)
  const target = object.type === 'MemberExpression' ? object.property : object;
  return target.type === 'Identifier' && (target.name === 'logger' || target.name === 'log');
}

function isSpanAttributeCall(node) {
  return (
    node?.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'span'
  );
}

export const strykerPlugins = [
  declareValuePlugin(PluginKind.Ignore, 'observability', {
    shouldIgnore(path) {
      if (path.isExpressionStatement() && isLogCall(path.node.expression)) return 'log line';
      // A block that only logs (e.g. a catch that records and moves on): emptying it changes no behaviour.
      if (
        path.isBlockStatement() &&
        path.node.body.length > 0 &&
        path.node.body.every((st) => st.type === 'ExpressionStatement' && isLogCall(st.expression))
      ) {
        return 'log-only block';
      }
      if (path.isExpressionStatement() && isSpanAttributeCall(path.node.expression)) return 'span attribute';
      if (path.isIfStatement() && path.node.consequent.type === 'ExpressionStatement') {
        if (isSpanAttributeCall(path.node.consequent.expression)) return 'span attribute';
      }
      // withSpan('name', { attrs }, fn): the name and attributes, not the callback.
      const parent = path.parent;
      if (
        parent?.type === 'CallExpression' &&
        parent.callee.type === 'Identifier' &&
        parent.callee.name === 'withSpan' &&
        path.listKey === 'arguments' &&
        path.key !== parent.arguments.length - 1
      ) {
        return 'span name/attributes';
      }
      return undefined;
    },
  }),
];

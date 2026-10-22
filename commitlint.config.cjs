// Conventional Commits: <type>(<scope>): <subject>
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      1,
      'always',
      [
        'catalog',
        'checkout',
        'orders',
        'invoicing',
        'worker',
        'api',
        'shared',
        'infra',
        'obs',
        'docs',
        'deps',
        'release',
      ],
    ],
    'subject-case': [2, 'never', ['upper-case', 'pascal-case', 'start-case']],
  },
};

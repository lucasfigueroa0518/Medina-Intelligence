import nextVitals from 'eslint-config-next/core-web-vitals';

const config = [
  ...nextVitals,
  {
    ignores: [
      '.next/**',
      'next-env.d.ts',
    ],
  },
  {
    rules: {
      'react/no-children-prop': 'warn',
      'react/no-unescaped-entities': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
];

export default config;

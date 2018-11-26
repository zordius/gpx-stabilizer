module.exports = {
  env: {
    jest: true
  },
  extends: [
    'standard',
    'prettier',
    'prettier/standard'
  ],
  rules: {
    'no-unused-vars': ['error', { args: 'after-used' }],
    'no-console': ['error', { allow: ['warn', 'error'] }],
    'import/no-unresolved': ['error']
  }
}

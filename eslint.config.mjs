// Stage 4 / P3-6：content script 是多个 classic script 按序加载，跨文件全局
// 靠 manifest 的顺序建立。这里从源码自动收集顶层声明，配合浏览器/扩展全局，
// 让 no-undef 能抓到真正的拼写错误，而不是误报跨文件引用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import globals from 'globals';
import { parse as parseJs } from 'espree';

const here = path.dirname(fileURLToPath(import.meta.url));
const declared = new Set();
for (const dir of ['src/content', 'src/shared', 'src/popup', 'src/background']) {
  const full = path.join(here, dir);
  if (!fs.existsSync(full)) continue;
  for (const file of fs.readdirSync(full).filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(full, file), 'utf8');
    // 用真正的解析器取顶层声明；正则会把 WGSL 模板字符串里的 `let x` 误当成声明
    let ast;
    try {
      ast = parseJs(text, { ecmaVersion: 2022, sourceType: 'script' });
    } catch {
      continue;
    }
    for (const node of ast.body) {
      if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
        if (node.id) declared.add(node.id.name);
      } else if (node.type === 'VariableDeclaration') {
        for (const d of node.declarations) {
          if (d.id.type === 'Identifier') declared.add(d.id.name);
          if (d.id.type === 'ObjectPattern') {
            for (const p of d.id.properties) if (p.value?.name) declared.add(p.value.name);
          }
        }
      }
    }
  }
}
// settings-schema / tone-math 用解构导出，正则抓不到，显式补名
for (const name of [
  'CURRENT_SETTINGS_VERSION', 'DEFAULT_SETTINGS', 'POWER_PRESETS', 'BT2446A_PRESETS',
  'RANGES', 'HdrToneMath', 'HDRSettings',
]) declared.add(name);

// classic script 里每个顶层声明都是事实上的跨文件导出；本文件内看不到使用
// 不代表没用，这类名字从 no-unused-vars 里豁免（真正的局部变量仍会被抓到）。
const exportedPattern = '^(_|' + [...declared].join('|') + ')$';
const noUnused = ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: exportedPattern }];

export default [
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        chrome: 'readonly',
        importScripts: 'readonly',
        GPUBufferUsage: 'readonly',
        GPUShaderStage: 'readonly',
        GPUTextureUsage: 'readonly',
        VideoFrame: 'readonly',
        // 跨文件全局在本文件里也会被赋值（如 nijiTimer），因此标为 writable
        ...Object.fromEntries([...declared].map((n) => [n, 'writable'])),
      },
    },
    rules: {
      'no-unused-vars': noUnused,
      'no-undef': 'error',
      // 顶层声明同时被登记为全局，no-redeclare 不要把「定义它的那个文件」报成重复
      'no-redeclare': ['error', { builtinGlobals: false }],
      // catch {} 是本项目常见的「旧浏览器无此 API」降级写法
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['tools/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': noUnused,
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['eslint.config.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.node },
  },
];

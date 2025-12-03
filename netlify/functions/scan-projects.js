const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

const execAsync = (command, options = {}) =>
  new Promise((resolve, reject) => {
    exec(command, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

const DEFAULT_IGNORED_DIRS = ['node_modules', '.git', '.cache', 'dist', 'build', 'library', 'packagecache'];
const IGNORED_FILES = new Set([
  '.gitignore',
  '.gitattributes',
  'edge-functions-import-map.json',
  'netlify.toml',
  'debug-env.js',
]);
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.rar',
  '.7z',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
]);
const MAX_SCAN_FILE_SIZE = 1_500_000; // ~1.5 MB safeguard against binary/huge files
const PROJECT_MARKERS = [
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'Gemfile',
  'composer.json',
  '.git',
];
const CONTAINER_ROOT_NAMES = new Set(['svn', 'bitbucket']);
const EXTENSION_TECH = {
  '.js': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.jsx': 'React (JSX)',
  '.ts': 'TypeScript',
  '.tsx': 'React (TSX)',
  '.json': 'JSON',
  '.html': 'HTML',
  '.htm': 'HTML',
  '.css': 'CSS',
  '.scss': 'Sass/SCSS',
  '.sass': 'Sass/SCSS',
  '.less': 'Less',
  '.md': 'Markdown',
  '.py': 'Python',
  '.rb': 'Ruby',
  '.java': 'Java',
  '.cs': 'C#',
  '.go': 'Go',
  '.php': 'PHP',
  '.rs': 'Rust',
  '.swift': 'Swift',
  '.kt': 'Kotlin',
  '.cpp': 'C++',
  '.c': 'C',
};

const PACKAGE_TECH = {
  react: 'React',
  'react-dom': 'React DOM',
  vue: 'Vue',
  '@angular/core': 'Angular',
  express: 'Express',
  next: 'Next.js',
  nuxt: 'Nuxt',
  svelte: 'Svelte',
  '@nestjs/core': 'NestJS',
  tailwindcss: 'Tailwind CSS',
  typescript: 'TypeScript',
  jest: 'Jest',
  vitest: 'Vitest',
  webpack: 'Webpack',
  rollup: 'Rollup',
  parcel: 'Parcel',
  eslint: 'ESLint',
  prettier: 'Prettier',
  '@babel/core': 'Babel',
};

const readFileSafe = async (filePath) =>
  new Promise((resolve, reject) => {
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(data);
    });
  });

async function gitHasUncommitted(repoPath) {
  const gitDir = path.join(repoPath, '.git');
  if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) {
    return false;
  }

  try {
    const { stdout } = await execAsync('git status --porcelain', { cwd: repoPath });
    return stdout.trim().length > 0;
  } catch (error) {
    return false;
  }
}

const identifierPatterns = [
  { type: 'function', regex: /function\s+([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*{/g },
  { type: 'method', regex: /\n\s*([a-zA-Z_$][\w$]*)\s*\([^;]*\)\s*{/g },
  { type: 'class', regex: /class\s+([A-Za-z_$][\w$]*)\s*(?:extends\s+[A-Za-z_$][\w$]*)?\s*{/g },
];

const SCOPE_PRIORITY = { method: 0, function: 1, class: 2 };

function normalizeCode(code) {
  return code
    .replace(/\/\/[\s\S]*?$/gm, '')
    .replace(/"|'/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCodeBlocks(content) {
  const blocks = [];

  identifierPatterns.forEach(({ type, regex }) => {
    let match;
    regex.lastIndex = 0;
    while ((match = regex.exec(content))) {
      const name = match[1];
      const braceIndex = content.indexOf('{', match.index);
      if (braceIndex === -1) continue;

      let depth = 0;
      let end = braceIndex;
      for (let i = braceIndex; i < content.length; i += 1) {
        const char = content[i];
        if (char === '{') depth += 1;
        else if (char === '}') depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }

      const raw = content.slice(match.index, end + 1);
      blocks.push({
        name,
        type,
        code: normalizeCode(raw).slice(0, 10_000),
        start: match.index,
        end,
      });
    }
  });

  return blocks;
}

function resolveVariableScope(index, codeBlocks) {
  const containingBlocks = codeBlocks.filter((block) => index >= block.start && index <= block.end);
  if (!containingBlocks.length) return 'global';

  const prioritized = containingBlocks.sort((a, b) => {
    const leftPriority = SCOPE_PRIORITY[a.type] ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = SCOPE_PRIORITY[b.type] ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return (a.end - a.start) - (b.end - b.start);
  });

  const scopeType = prioritized[0]?.type;
  if (scopeType === 'method') return 'method';
  if (scopeType === 'function') return 'function';
  if (scopeType === 'class') return 'class';
  return 'global';
}

function extractIdentifiers(content) {
  const codeBlocks = extractCodeBlocks(content);
  const variableMatches = [...content.matchAll(/(?:const|let|var)\s+([a-zA-Z_$][\w$]*)/g)];
  const variables = [];
  const variableDetails = [];

  variableMatches.forEach((match) => {
    const name = match[1];
    const scope = resolveVariableScope(match.index ?? 0, codeBlocks);
    variables.push(name);
    variableDetails.push({ name, scope });
  });

  const functions = [...content.matchAll(/function\s+([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]);
  const classes = [...content.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const methods = [...content.matchAll(/\n\s*([a-zA-Z_$][\w$]*)\s*\([^;]*\)\s*{/g)].map((m) => m[1]);
  return { variables, variableDetails, functions, classes, methods, codeBlocks };
}

async function hashFile(filePath) {
  const content = await readFileSafe(filePath);
  return crypto.createHash('sha1').update(content).digest('hex');
}

function isSkippableBinary(filePath, stats) {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  return stats.size === 0;
}

function collectTechFromFile(filePath, techSet) {
  const ext = path.extname(filePath).toLowerCase();
  if (EXTENSION_TECH[ext]) {
    techSet.add(EXTENSION_TECH[ext]);
  }

  const base = path.basename(filePath).toLowerCase();
  if (base === 'dockerfile') {
    techSet.add('Docker');
  }
  if (base === 'docker-compose.yml' || base === 'docker-compose.yaml') {
    techSet.add('Docker Compose');
  }
  if (base === 'makefile') {
    techSet.add('Makefile');
  }
}

function collectTechFromPackageJson(projectPath, techSet) {
  const pkgPath = path.join(projectPath, 'package.json');
  if (!fs.existsSync(pkgPath)) return;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    techSet.add('Node.js');
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    Object.keys(deps || {}).forEach((dep) => {
      if (PACKAGE_TECH[dep]) {
        techSet.add(PACKAGE_TECH[dep]);
      }
    });
  } catch (error) {
    // ignore parse errors
  }
}

function isProjectDirectory(directoryPath) {
  return PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(directoryPath, marker)));
}

function isContainerDirectory(directoryPath) {
  const name = path.basename(directoryPath).toLowerCase();
  const parentName = path.basename(path.dirname(directoryPath)).toLowerCase();

  return name === 'svn' || (parentName === 'svn' && CONTAINER_ROOT_NAMES.has(name));
}

function extractReferenceTargets(content) {
  const targets = new Set();
  const importPattern = /import[^'"`]*['"`]([^'"`]+)['"`]/g;
  const requirePattern = /require\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  const dynamicImportPattern = /import\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

  [importPattern, requirePattern, dynamicImportPattern].forEach((regex) => {
    regex.lastIndex = 0;
    for (const match of content.matchAll(regex)) {
      if (match[1]) {
        targets.add(match[1]);
      }
    }
  });

  return [...targets];
}

function buildIgnoredSet(extraIgnores = []) {
  const set = new Set(DEFAULT_IGNORED_DIRS.map((name) => name.toLowerCase()));
  extraIgnores
    .map((name) => String(name || '').trim().toLowerCase())
    .filter(Boolean)
    .forEach((name) => set.add(name));
  return set;
}

async function walkFiles(baseDir, ignoredDirs) {
  const files = [];
  const stack = [baseDir];

  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.forEach((entry) => {
      if (ignoredDirs.has(entry.name.toLowerCase())) {
        return;
      }

      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    });
  }

  return files;
}

async function inspectProject(projectPath, ignoredDirs) {
  const filePaths = await walkFiles(projectPath, ignoredDirs);
  const files = [];
  const variables = [];
  const variableDetails = [];
  const functions = [];
  const classes = [];
  const methods = [];
  const identifierDetails = [];
  const technologies = new Set();
  const referenceMentions = new Set();
  const name = getProjectName(projectPath);

  for (const filePath of filePaths) {
    try {
      const fileName = path.basename(filePath).toLowerCase();
      if (IGNORED_FILES.has(fileName)) {
        continue;
      }

      collectTechFromFile(filePath, technologies);
      const stats = fs.statSync(filePath);
      if (stats.size > MAX_SCAN_FILE_SIZE) {
        continue; // skip oversized files while keeping scan responsive
      }

      if (isSkippableBinary(filePath, stats)) {
        continue;
      }

      const content = await readFileSafe(filePath);
      const identifiers = extractIdentifiers(content);
      extractReferenceTargets(content).forEach((target) => referenceMentions.add(target));
      const relativePath = path.relative(projectPath, filePath);
      files.push({
        relativePath,
        fullPath: filePath,
        ...identifiers,
      });
      variables.push(...identifiers.variables);
      variableDetails.push(...identifiers.variableDetails);
      functions.push(...identifiers.functions);
      classes.push(...identifiers.classes);
      methods.push(...identifiers.methods);

      identifiers.codeBlocks.forEach((block) => {
        identifierDetails.push({
          name: block.name,
          type: block.type,
          file: relativePath,
          codeHash: crypto.createHash('sha1').update(block.code).digest('hex'),
        });
      });
    } catch (err) {
      // Skip unreadable files
    }
  }

  collectTechFromPackageJson(projectPath, technologies);
  const hasUncommitted = await gitHasUncommitted(projectPath);

  const variableGroups = {
    global: new Set(),
    class: new Set(),
    function: new Set(),
    method: new Set(),
  };

  variableDetails.forEach((detail) => {
    if (variableGroups[detail.scope]) {
      variableGroups[detail.scope].add(detail.name);
    }
  });

  const variablesByScope = Object.fromEntries(
    Object.entries(variableGroups).map(([scope, set]) => [scope, [...set].sort((a, b) => a.localeCompare(b))])
  );

  return {
    name,
    path: projectPath,
    files,
    variables: [...new Set(variables)],
    variableGroups: variablesByScope,
    functions: [...new Set(functions)],
    classes: [...new Set(classes)],
    methods: [...new Set(methods)],
    identifierDetails,
    hasUncommitted,
    technologies: [...technologies].sort(),
    referenceMentions: [...referenceMentions],
    references: [],
  };
}

function getProjectName(projectPath) {
  const normalizedPath = path.normalize(projectPath);
  const netlifyFunctionsSegment = `${path.sep}netlify${path.sep}functions`;
  const netlifyIndex = normalizedPath.toLowerCase().indexOf(netlifyFunctionsSegment);

  if (netlifyIndex !== -1) {
    const rootPath = normalizedPath.slice(0, netlifyIndex) || normalizedPath;
    const parentName = path.basename(rootPath);
    if (parentName) return parentName;
  }

  return path.basename(projectPath);
}

function isNetlifyFunctionsPath(projectPath) {
  const normalized = projectPath.split(path.sep).map((segment) => segment.toLowerCase());
  const netlifyIndex = normalized.indexOf('netlify');

  if (netlifyIndex === -1) return false;

  return normalized[netlifyIndex + 1] === 'functions';
}

async function findProjects(rootDir, ignoredDirs) {
  const projects = [];
  const stack = [rootDir];

  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || ignoredDirs.has(entry.name.toLowerCase())) continue;

      const projectPath = path.join(current, entry.name);
      if (
        !isContainerDirectory(projectPath) &&
        isProjectDirectory(projectPath) &&
        !isNetlifyFunctionsPath(projectPath)
      ) {
        projects.push(await inspectProject(projectPath, ignoredDirs));
      }
      stack.push(projectPath);
    }
  }

  return projects;
}

function buildDuplicateMatrix(projects) {
  const signatureMap = new Map();

  const hashPromises = projects.flatMap((project) =>
    project.files.map((file) =>
      hashFile(file.fullPath)
        .then((hash) => {
          const entry = signatureMap.get(hash) || [];
          entry.push({ project: project.name, file });
          signatureMap.set(hash, entry);
        })
        .catch(() => {})
    )
  );

  return Promise.all(hashPromises).then(() => {
    const duplicates = [];
    signatureMap.forEach((list) => {
      const projectSet = new Set(list.map((item) => item.project));
      if (projectSet.size > 1) {
        duplicates.push({
          projects: [...projectSet],
          files: list.map((item) => `${item.project}/${item.file.relativePath}`),
        });
      }
    });
    return duplicates;
  });
}

function applyReferences(projects) {
  const nameMap = new Map(projects.map((project) => [project.name.toLowerCase(), project.name]));
  const matchesName = (candidate, name) => {
    const value = candidate.toLowerCase();
    return (
      value === name ||
      value.endsWith(`/${name}`) ||
      value.includes(`/${name}/`) ||
      value.includes(`@${name}`) ||
      value.includes(`:${name}`) ||
      value.includes(`${name}/`) ||
      value.includes(`${name}.`)
    );
  };

  projects.forEach((project) => {
    const refSet = new Set();
    const externalSet = new Set();
    project.referenceMentions.forEach((mention) => {
      let matched = false;
      nameMap.forEach((original, lowerName) => {
        if (project.name.toLowerCase() !== lowerName && matchesName(mention, lowerName)) {
          matched = true;
          refSet.add(original);
        }
      });
      if (!matched) {
        externalSet.add(mention);
      }
    });
    project.references = [...refSet];
    project.externalReferences = [...externalSet];
    delete project.referenceMentions;
  });
}

function findSharedIdentifiers(projects) {
  const map = new Map();

  projects.forEach((project) => {
    (project.identifierDetails || []).forEach((detail) => {
      const key = `${detail.type}:${detail.name}`;
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key).push({ project: project.name, codeHash: detail.codeHash, file: detail.file });
    });
  });

  const shared = [];
  map.forEach((list, key) => {
    const projectSet = new Set(list.map((item) => item.project));
    if (projectSet.size <= 1) return;

    const [type, name] = key.split(':');
    const hashGroups = new Map();
    list.forEach((item) => {
      if (!item.codeHash) return;
      const existing = hashGroups.get(item.codeHash) || new Set();
      existing.add(item.project);
      hashGroups.set(item.codeHash, existing);
    });

    const hardMatches = [...hashGroups.values()].filter((set) => set.size > 1);
    shared.push({
      name,
      type,
      projects: [...projectSet],
      strength: hardMatches.length ? 'hard' : 'soft',
      overlaps: hardMatches.map((set) => [...set]),
    });
  });

  return shared.sort((a, b) => a.name.localeCompare(b.name));
}

exports.handler = async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { directory, excludeFolders } = JSON.parse(event.body || '{}');
    if (!directory) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Directory is required' }) };
    }

    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Directory not found' }) };
    }

    const ignoredDirs = buildIgnoredSet(Array.isArray(excludeFolders) ? excludeFolders : []);
    const projects = await findProjects(directory, ignoredDirs);
    applyReferences(projects);
    const duplicates = await buildDuplicateMatrix(projects);
    const sharedIdentifiers = findSharedIdentifiers(projects);

    return {
      statusCode: 200,
      body: JSON.stringify({ projects, duplicates, sharedIdentifiers }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message || 'Unexpected error' }),
    };
  }
};

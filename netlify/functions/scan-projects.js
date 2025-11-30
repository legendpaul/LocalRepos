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

const IGNORED_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'build']);
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

function extractIdentifiers(content) {
  const variables = [...content.matchAll(/(?:const|let|var)\s+([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]);
  const functions = [...content.matchAll(/function\s+([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]);
  const classes = [...content.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const methods = [...content.matchAll(/\n\s*([a-zA-Z_$][\w$]*)\s*\([^;]*\)\s*{/g)].map((m) => m[1]);
  return { variables, functions, classes, methods };
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

async function walkFiles(baseDir) {
  const files = [];
  const stack = [baseDir];

  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.forEach((entry) => {
      if (IGNORED_DIRS.has(entry.name)) {
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

async function inspectProject(projectPath) {
  const filePaths = await walkFiles(projectPath);
  const files = [];
  const variables = [];
  const functions = [];
  const classes = [];
  const methods = [];
  const technologies = new Set();
  const referenceMentions = new Set();

  for (const filePath of filePaths) {
    try {
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
      functions.push(...identifiers.functions);
      classes.push(...identifiers.classes);
      methods.push(...identifiers.methods);
    } catch (err) {
      // Skip unreadable files
    }
  }

  collectTechFromPackageJson(projectPath, technologies);
  const hasUncommitted = await gitHasUncommitted(projectPath);
  return {
    name: path.basename(projectPath),
    path: projectPath,
    files,
    variables,
    functions,
    classes,
    methods,
    hasUncommitted,
    technologies: [...technologies].sort(),
    referenceMentions: [...referenceMentions],
    references: [],
  };
}

async function findProjects(rootDir) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const projects = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectPath = path.join(rootDir, entry.name);
    projects.push(await inspectProject(projectPath));
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
    project.referenceMentions.forEach((mention) => {
      nameMap.forEach((original, lowerName) => {
        if (project.name.toLowerCase() !== lowerName && matchesName(mention, lowerName)) {
          refSet.add(original);
        }
      });
    });
    project.references = [...refSet];
    delete project.referenceMentions;
  });
}

exports.handler = async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { directory } = JSON.parse(event.body || '{}');
    if (!directory) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Directory is required' }) };
    }

    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Directory not found' }) };
    }

    const projects = await findProjects(directory);
    applyReferences(projects);
    const duplicates = await buildDuplicateMatrix(projects);

    return {
      statusCode: 200,
      body: JSON.stringify({ projects, duplicates }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message || 'Unexpected error' }),
    };
  }
};

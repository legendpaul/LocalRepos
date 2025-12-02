const form = document.getElementById('scan-form');
const directoryInput = document.getElementById('directory');
const statusEl = document.getElementById('status');
const resultsGrid = document.getElementById('results');
const duplicatesSection = document.getElementById('duplicates');
const duplicateList = document.getElementById('duplicate-list');
const pickButton = document.getElementById('pick-directory');
const directoryPickerFallback = document.getElementById('directory-picker-input');
const filtersSection = document.getElementById('filters');
const searchInput = document.getElementById('search');
const includeTechnologyFilter = document.getElementById('include-technology-filter');
const excludeTechnologyFilter = document.getElementById('exclude-technology-filter');
const relationshipsSection = document.getElementById('relationships');
const relationshipSvg = document.getElementById('relationship-graph');
const relationshipDetails = document.getElementById('relationship-details');
const excludeFolderContainer = document.getElementById('exclude-folders');
const excludeCustomInput = document.getElementById('exclude-custom');

let allProjects = [];
let duplicatesData = [];
let relationshipEdges = [];
let activeScanId = 0;

const formatCount = (label, count) => `${count} ${label}${count === 1 ? '' : 's'}`;
const projectAnchorId = (name) => `project-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

function setStatus(message, mode = 'idle') {
  statusEl.textContent = message;
  statusEl.className = `status status--${mode}`;
}

function setDirectoryFromFiles(fileList) {
  const [first] = fileList || [];
  if (!first) {
    setStatus('Directory selection was cancelled.', 'warn');
    return;
  }

  const relativePath = first.webkitRelativePath || '';
  const topLevelFolder = relativePath.split('/')[0] || first.name || 'selected directory';
  directoryInput.value = topLevelFolder;
  setStatus(`Selected "${topLevelFolder}". Update to a server-visible path if needed.`, 'success');
}

function openFallbackPicker() {
  if (!directoryPickerFallback) {
    setStatus('Directory picking is not supported in this browser; please type a path.', 'error');
    return;
  }

  directoryPickerFallback.value = '';
  directoryPickerFallback.click();
}

async function tryDirectoryPicker() {
  if (!window.showDirectoryPicker) {
    openFallbackPicker();
    return;
  }

  try {
    const handle = await window.showDirectoryPicker();
    const name = handle.name || 'selected directory';
    directoryInput.value = name;
    setStatus(`Selected "${name}". Update to a server-visible path if needed.`, 'success');
  } catch (err) {
    if (err?.name === 'AbortError') {
      setStatus('Directory selection was cancelled.', 'warn');
      return;
    }

    console.error(err);
    openFallbackPicker();
  }
}

function renderProject(project) {
  const card = document.createElement('article');
  card.className = 'card';
  card.id = projectAnchorId(project.name);

  const title = document.createElement('h3');
  title.className = 'card__title';
  title.textContent = project.name;
  const filePill = document.createElement('span');
  filePill.className = 'pill';
  filePill.textContent = `${project.files.length} files`;
  title.appendChild(filePill);
  card.appendChild(title);

  const gitPill = document.createElement('span');
  gitPill.className = `pill ${project.hasUncommitted ? 'pill--warn' : 'pill--success'}`;
  gitPill.textContent = project.hasUncommitted ? 'Uncommitted changes' : 'Clean git state';
  card.appendChild(gitPill);

  const meta = document.createElement('ul');
  meta.className = 'meta-list';

  const metaItems = [
    { label: 'Path', value: project.path },
    { label: 'Files scanned', value: project.files.length },
    { label: 'Functions', value: project.functions?.length ?? 0 },
    { label: 'Detected variables', value: project.variables.length },
    { label: 'Classes', value: project.classes.length },
    { label: 'Methods', value: project.methods.length },
  ];

  metaItems.forEach((item) => {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'meta-label';
    label.textContent = item.label;
    const value = document.createElement('span');
    value.className = 'code-pill';
    value.textContent = item.value;
    li.appendChild(label);
    li.appendChild(value);
    meta.appendChild(li);
  });

  card.appendChild(meta);

  const filesTitle = document.createElement('p');
  filesTitle.className = 'eyebrow';
  filesTitle.textContent = 'Files with identifiers';
  card.appendChild(filesTitle);

  if (project.technologies?.length) {
    const techLabel = document.createElement('p');
    techLabel.className = 'eyebrow';
    techLabel.textContent = 'Technologies';
    card.appendChild(techLabel);

    const techList = document.createElement('div');
    techList.className = 'tags';
    project.technologies.forEach((tech) => {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = tech;
      techList.appendChild(tag);
    });
    card.appendChild(techList);
  }

  const fileList = document.createElement('div');
  fileList.className = 'list';

  project.files.slice(0, 8).forEach((file) => {
    const item = document.createElement('div');
    item.className = 'list__item';
    const heading = document.createElement('p');
    heading.className = 'list__title';
    heading.textContent = file.relativePath;
    item.appendChild(heading);

    const tags = document.createElement('div');
    tags.className = 'tags';

    if (file.variables.length) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = formatCount('var', file.variables.length);
      tags.appendChild(tag);
    }

    if (file.functions.length) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = formatCount('function', file.functions.length);
      tags.appendChild(tag);
    }

    if (file.classes.length) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = formatCount('class', file.classes.length);
      tags.appendChild(tag);
    }

    if (file.methods.length) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = formatCount('method', file.methods.length);
      tags.appendChild(tag);
    }

    item.appendChild(tags);
    fileList.appendChild(item);
  });

  card.appendChild(fileList);

  if (project.references.length) {
    const refLabel = document.createElement('p');
    refLabel.className = 'small';
    refLabel.textContent = `References: ${project.references.join(', ')}`;
    card.appendChild(refLabel);
  }

  return card;
}

function renderProjects(projects) {
  resultsGrid.innerHTML = '';

  if (!projects.length) {
    const empty = document.createElement('p');
    empty.className = 'small';
    empty.textContent = 'No projects match your search. Try adjusting the filters.';
    resultsGrid.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  projects.forEach((project) => fragment.appendChild(renderProject(project)));
  resultsGrid.appendChild(fragment);
}

function populateTechnologyFilters(projects) {
  const techSet = new Set();
  projects.forEach((project) => project.technologies?.forEach((tech) => techSet.add(tech)));

  const selects = [includeTechnologyFilter, excludeTechnologyFilter];
  selects.forEach((select) => {
    if (!select) return;
    const previousSelection = new Set(Array.from(select.selectedOptions || []).map((opt) => opt.value));
    select.innerHTML = '';

    [...techSet].sort().forEach((tech) => {
      const option = document.createElement('option');
      option.value = tech;
      option.textContent = tech;
      option.selected = previousSelection.has(tech);
      select.appendChild(option);
    });
  });
}

function applyFilters() {
  const term = searchInput.value.trim().toLowerCase();

  const getSelectedTechnologies = (selectEl) =>
    Array.from(selectEl?.selectedOptions || [])
      .map((opt) => opt.value)
      .filter(Boolean);

  const includedTech = getSelectedTechnologies(includeTechnologyFilter);
  const excludedTech = getSelectedTechnologies(excludeTechnologyFilter);

  const filtered = allProjects.filter((project) => {
    const technologies = project.technologies || [];
    const matchesIncluded = includedTech.length
      ? includedTech.every((tech) => technologies.includes(tech))
      : true;
    const matchesExcluded = excludedTech.length ? !excludedTech.some((tech) => technologies.includes(tech)) : true;
    const termTargets = [
      project.name,
      project.path,
      project.technologies?.join(' '),
      String(project.files.length),
      String(project.variables.length),
      String(project.functions?.length ?? 0),
      String(project.methods.length),
      String(project.classes.length),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    const tokens = term.split(/\s+/).filter(Boolean);
    const matchesTerm = tokens.length ? tokens.every((token) => termTargets.includes(token)) : true;
    return matchesIncluded && matchesExcluded && matchesTerm;
  });

  renderProjects(filtered);
  renderRelationships(filtered);
}

function renderDuplicates(duplicates) {
  duplicateList.innerHTML = '';
  duplicatesSection.hidden = duplicates.length === 0;
  if (!duplicates.length) return;

  const fragment = document.createDocumentFragment();
  duplicates.forEach((entry) => {
    const item = document.createElement('div');
    item.className = 'list__item';
    const title = document.createElement('p');
    title.className = 'list__title';
    title.textContent = `${entry.projects.join(', ')} share ${entry.files.length} files`;
    item.appendChild(title);

    const paths = document.createElement('p');
    paths.className = 'small';
    paths.textContent = entry.files.join(' · ');
    item.appendChild(paths);
    fragment.appendChild(item);
  });

  duplicateList.appendChild(fragment);
}

function buildRelationshipEdges(projects, duplicates) {
  const nodeNames = new Set(projects.map((project) => project.name));
  const edgeMap = new Map();

  const addEdge = (a, b, type, weight = 1) => {
    const [source, target] = [a, b].sort();
    const key = `${type}:${source}|${target}`;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, { source, target, type, weight: 0 });
    }
    const edge = edgeMap.get(key);
    edge.weight += weight;
  };

  duplicates.forEach((entry) => {
    const participants = entry.projects.filter((name) => nodeNames.has(name));
    for (let i = 0; i < participants.length; i += 1) {
      for (let j = i + 1; j < participants.length; j += 1) {
        addEdge(participants[i], participants[j], 'duplicate', entry.files.length || 1);
      }
    }
  });

  projects.forEach((project) => {
    project.references?.forEach((ref) => {
      if (nodeNames.has(ref)) {
        addEdge(project.name, ref, 'reference');
      }
    });
  });

  return [...edgeMap.values()];
}

function renderRelationships(projects) {
  if (!relationshipSvg || !relationshipsSection) return;

  relationshipSvg.innerHTML = '';
  relationshipEdges = [];
  if (relationshipDetails) {
    relationshipDetails.textContent = 'Select a project node to inspect its links.';
  }

  if (!projects.length) {
    relationshipsSection.hidden = true;
    return;
  }

  relationshipsSection.hidden = false;

  const edges = buildRelationshipEdges(projects, duplicatesData);
  relationshipEdges = edges;

  const measuredWidth = relationshipSvg.clientWidth || relationshipSvg.parentElement?.clientWidth || 900;
  const height = 420;
  const centerX = measuredWidth / 2 || 450;
  const centerY = height / 2;
  const radius = Math.max(Math.min(measuredWidth, height) / 2 - 60, 120);

  relationshipSvg.setAttribute('viewBox', `0 0 ${measuredWidth || 900} ${height}`);
  const nodePositions = new Map();

  projects.forEach((project, idx) => {
    const angle = (idx / projects.length) * Math.PI * 2;
    const x = centerX + radius * Math.cos(angle);
    const y = centerY + radius * Math.sin(angle);
    nodePositions.set(project.name, { x, y });
  });

  const svgNS = 'http://www.w3.org/2000/svg';

  edges.forEach((edge) => {
    const from = nodePositions.get(edge.source);
    const to = nodePositions.get(edge.target);
    if (!from || !to) return;
    const color = edge.type === 'duplicate' ? '#22d3ee' : '#f59e0b';
    const widthScale = Math.min(6, 1 + Math.log2(edge.weight + 1));
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', String(from.x));
    line.setAttribute('y1', String(from.y));
    line.setAttribute('x2', String(to.x));
    line.setAttribute('y2', String(to.y));
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', String(widthScale));
    line.setAttribute('opacity', '0.7');
    relationshipSvg.appendChild(line);
  });

  projects.forEach((project) => {
    const pos = nodePositions.get(project.name);
    if (!pos) return;
    const techLabel = project.technologies?.slice(0, 2).join(' · ') || 'Project';
    const group = document.createElementNS(svgNS, 'g');
    group.classList.add('relationship-node');
    group.dataset.node = project.name;
    group.setAttribute('transform', `translate(${pos.x}, ${pos.y})`);

    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('r', '26');
    circle.setAttribute('fill', '#0ea5e9');
    circle.setAttribute('stroke', '#0f172a');
    circle.setAttribute('stroke-width', '3');
    group.appendChild(circle);

    const nameText = document.createElementNS(svgNS, 'text');
    nameText.setAttribute('text-anchor', 'middle');
    nameText.setAttribute('dy', '-34');
    nameText.classList.add('node__name');
    nameText.textContent = project.name;
    group.appendChild(nameText);

    const metaText = document.createElementNS(svgNS, 'text');
    metaText.setAttribute('text-anchor', 'middle');
    metaText.setAttribute('dy', '44');
    metaText.classList.add('node__meta');
    metaText.textContent = techLabel;
    group.appendChild(metaText);

    relationshipSvg.appendChild(group);
  });
}

function showRelationshipDetails(projectName) {
  const project = allProjects.find((p) => p.name === projectName);
  if (!project) return;

  const connections = relationshipEdges
    .filter((edge) => edge.source === projectName || edge.target === projectName)
    .map((edge) => ({
      type: edge.type,
      weight: edge.weight,
      other: edge.source === projectName ? edge.target : edge.source,
    }));

  relationshipDetails.innerHTML = '';

  const title = document.createElement('h3');
  title.className = 'card__title';
  title.textContent = project.name;
  relationshipDetails.appendChild(title);

  const pathText = document.createElement('p');
  pathText.className = 'small';
  pathText.textContent = project.path;
  relationshipDetails.appendChild(pathText);

  const gitLabel = document.createElement('p');
  gitLabel.className = 'eyebrow';
  gitLabel.textContent = 'Git';
  relationshipDetails.appendChild(gitLabel);

  const gitState = document.createElement('p');
  gitState.className = 'small';
  gitState.textContent = project.hasUncommitted ? 'Uncommitted changes' : 'Clean working tree';
  relationshipDetails.appendChild(gitState);

  const techLabel = document.createElement('p');
  techLabel.className = 'eyebrow';
  techLabel.textContent = 'Technologies';
  relationshipDetails.appendChild(techLabel);

  if (project.technologies?.length) {
    const techTags = document.createElement('div');
    techTags.className = 'tags';
    project.technologies.forEach((tech) => {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = tech;
      techTags.appendChild(tag);
    });
    relationshipDetails.appendChild(techTags);
  } else {
    const noTech = document.createElement('p');
    noTech.className = 'small';
    noTech.textContent = 'No technologies detected.';
    relationshipDetails.appendChild(noTech);
  }

  const linksLabel = document.createElement('p');
  linksLabel.className = 'eyebrow';
  linksLabel.textContent = 'Links';
  relationshipDetails.appendChild(linksLabel);

  if (connections.length) {
    const tags = document.createElement('div');
    tags.className = 'tags';
    connections.forEach((conn) => {
      const tag = document.createElement('span');
      tag.className = `tag ${conn.type === 'duplicate' ? 'tag--accent' : 'tag--warn'}`;
      const weightLabel = conn.weight > 1 ? ` (${conn.weight})` : '';
      tag.textContent = `${conn.type === 'duplicate' ? 'Shared code' : 'Reference'} with ${conn.other}${weightLabel}`;
      tags.appendChild(tag);
    });
    relationshipDetails.appendChild(tags);
  } else {
    const noLinks = document.createElement('p');
    noLinks.className = 'small';
    noLinks.textContent = 'No links detected for this project.';
    relationshipDetails.appendChild(noLinks);
  }

  const actions = document.createElement('div');
  actions.className = 'relationship-actions';
  const scrollBtn = document.createElement('button');
  scrollBtn.type = 'button';
  scrollBtn.className = 'ghost';
  scrollBtn.dataset.scrollTarget = project.name;
  scrollBtn.textContent = 'Scroll to project';
  actions.appendChild(scrollBtn);
  relationshipDetails.appendChild(actions);
}

function scrollToProject(projectName) {
  const target = document.getElementById(projectAnchorId(projectName));
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('card--highlight');
    setTimeout(() => target.classList.remove('card--highlight'), 1600);
  }
}

function resetResultsUI() {
  resultsGrid.innerHTML = '';
  duplicateList.innerHTML = '';
  duplicatesSection.hidden = true;
  relationshipsSection.hidden = true;
  if (relationshipSvg) relationshipSvg.innerHTML = '';
  if (relationshipDetails) relationshipDetails.textContent = 'Scanning workspace...';
}

function isLikelyAbsolutePath(value) {
  return value.startsWith('/') || /^[a-zA-Z]:(\\\\|\\)/.test(value);
}

function normalizeDirectorySeparators(value) {
  if (!/^[a-zA-Z]:/.test(value)) {
    return value;
  }

  const collapsed = value.replace(/\\+/g, '\\');
  return collapsed.replace(/\\/g, '\\\\');
}

function getExcludedFolders() {
  const checkboxValues = Array.from(
    excludeFolderContainer?.querySelectorAll('input[name="exclude-folder"]') || []
  )
    .filter((input) => input.checked)
    .map((input) => input.value.trim())
    .filter(Boolean);

  const customValues = (excludeCustomInput?.value || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return [...new Set([...checkboxValues, ...customValues])];
}

async function handleSubmit(event) {
  event.preventDefault();
  const rawDirectory = directoryInput.value.trim();
  if (!rawDirectory) {
    setStatus('Please provide a directory path.', 'error');
    return;
  }

  const directory = normalizeDirectorySeparators(rawDirectory);

  if (!isLikelyAbsolutePath(directory)) {
    setStatus('Please enter a full path that the server can access (e.g., C\\Repos or /var/repos).', 'warn');
    return;
  }

  if (window.location.protocol === 'file:') {
    setStatus(
      'Scanning requires running the app from a local server (e.g., via "npm start") so it can reach the Netlify function.',
      'error'
    );
    return;
  }

  setStatus('Scanning projects...', 'loading');
  resetResultsUI();
  const scanId = Date.now();
  activeScanId = scanId;

  const excludeFolders = getExcludedFolders();

  try {
    const response = await fetch('/.netlify/functions/scan-projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory, excludeFolders }),
    });

    const payload = await response.json();

    if (!response.ok) {
      const message = payload?.error || response.statusText;
      throw new Error(`Request failed: ${message}`);
    }

    const { projects, duplicates } = payload;

    if (scanId !== activeScanId) {
      return;
    }

    allProjects = projects;
    duplicatesData = duplicates;

    populateTechnologyFilters(projects);
    filtersSection.hidden = projects.length === 0;

    renderProjects(projects);
    renderDuplicates(duplicates);
    renderRelationships(projects);
    setStatus(`Scanned ${projects.length} project${projects.length === 1 ? '' : 's'}.`, 'success');
  } catch (error) {
    console.error(error);
    setStatus(error.message || 'Scanning failed.', 'error');
  }
}

pickButton.addEventListener('click', tryDirectoryPicker);
directoryPickerFallback?.addEventListener('change', () => {
  setDirectoryFromFiles(directoryPickerFallback.files);
});
form.addEventListener('submit', handleSubmit);
searchInput.addEventListener('input', applyFilters);
includeTechnologyFilter?.addEventListener('change', applyFilters);
excludeTechnologyFilter?.addEventListener('change', applyFilters);
relationshipSvg?.addEventListener('click', (event) => {
  const nodeEl = event.target.closest('[data-node]');
  if (nodeEl) {
    showRelationshipDetails(nodeEl.dataset.node);
  }
});

relationshipDetails?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-scroll-target]');
  if (button) {
    scrollToProject(button.dataset.scrollTarget);
  }
});

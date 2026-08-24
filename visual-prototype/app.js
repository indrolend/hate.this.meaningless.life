(async () => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  let liveState = false;
  let state = window.commandHudRealState;
  let runtime = null;
  try {
    const response = await fetch('/state', { cache: 'no-store' });
    if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
      state = await response.json();
      liveState = true;
      const runtimeResponse = await fetch('/runtime', { cache: 'no-store' });
      if (runtimeResponse.ok) runtime = await runtimeResponse.json();
    }
  } catch {}
  const repository = state?.repository;
  let search = state?.lastOperation?.type === 'search' ? state.lastOperation : null;
  const searchFiles = new Map((search?.files || []).map((file) => [file.path, file]));
  const searchOrder = (search?.files || []).map((file) => file.path);
  let activeSearchRunId = search ? state?.last?.runId : null;
  const app = $('#app');
  const viewport = $('#viewport');
  const world = $('#world');
  const treeList = $('#treeList');
  const focus = $('#focusPanel');
  const input = $('#commandInput');
  const picker = $('#picker');
  const toolkit = $('#toolkitButton');
  const output = $('#output');
  const palette = ['#78d5e1', '#d4ec8e', '#7773ce', '#e1b87f', '#b45aac', '#7fa9ae'];
  const filesByPath = new Map();
  const directoriesByPath = new Map();
  const layoutByPath = new Map();
  const openDirectories = new Set(['']);
  const pointers = new Map();
  let currentDirectory = '';
  let selected = null;
  let camera = { x: 48, y: 48, z: 0.92 };
  let gesture = null;
  let inputMode = 'terminal';
  const openMenuSections = new Set(['HUD']);
  let renderedCommands = [];

  const commands = {
    HUD: [
      ['Undo latest change', 'Inspect and reverse the newest safe recorded change.', '', 'evidence', null, 'undo'],
      ['Operation history', 'Browse immutable searches, commands, cancellations, and Undo evidence.', '', 'evidence', null, 'history'],
      ['Refresh repository', 'Reload live repository and runtime state.', '', 'workspace', null, 'refresh'],
      ['Copy last handoff', 'Copy compact context for the last structured operation.', '', 'evidence', null, 'handoff'],
    ],
    Repository: [
      ['Current semantic state', 'Inspect the complete derived HUD snapshot.', 'node tools/hud/cli.mjs state --json', 'HUD'],
      ['Repository tree', 'Inspect the Git-backed repository projection.', 'node tools/hud/cli.mjs tree', 'HUD'],
    ],
    Search: [
      ['Search repository', 'Run a recorded literal search across the repository.', 'search "" .', 'repository', null, 'search-repository'],
      ['Search current directory', 'Run a recorded literal search in the visible map scope.', 'search "" {current}', 'current directory', null, 'search-current'],
    ],
    Git: [
      ['Repository status', 'Show branch and concise worktree state.', 'git status --short --branch', 'repository'],
      ['Review all changes', 'Show the current worktree patch.', 'git diff', 'worktree'],
      ['Recent commits', 'Show recent checkpoints.', 'git log -8 --oneline --decorate', 'repository'],
    ],
    Selection: [
      ['Review selected changes', 'Show the selected file’s Git patch.', 'git diff -- {selection}', 'selection'],
      ['Open selected file', 'Prepare the conventional editor command.', 'code --goto {selection}', 'selection'],
    ],
  };
  const discovered = state?.commands || [];
  const packageNames = discovered.filter((entry) => entry.name.startsWith('npm:')).map((entry) => entry.name.slice(4));
  const namespaces = new Set(packageNames.filter((name) => name.includes(':')).map((name) => name.split(':')[0]));
  const libraryGroups = new Map();
  for (const entry of discovered) {
    const packageScript = entry.name.startsWith('npm:');
    const rawName = packageScript ? entry.name.slice(4) : entry.name;
    const prefix = packageScript && (rawName.includes(':') || namespaces.has(rawName)) ? rawName.split(':')[0] : packageScript ? 'general' : 'tools';
    const displayName = packageScript && prefix !== 'general'
      ? rawName.includes(':') ? rawName.slice(prefix.length + 1) : 'default'
      : rawName;
    if (!libraryGroups.has(prefix)) libraryGroups.set(prefix, []);
    libraryGroups.get(prefix).push([
      displayName,
      packageScript ? 'Script declared by this repository.' : 'Command adapter discovered in this repository.',
      entry.command,
      packageScript ? 'package script' : 'repository tool',
      entry.name,
    ]);
  }
  const groupLabel = (name) => name.length <= 3 ? name.toUpperCase() : `${name[0].toUpperCase()}${name.slice(1)}`;
  for (const name of [...libraryGroups.keys()].sort()) commands[`Commands · ${groupLabel(name)}`] = libraryGroups.get(name);

  function indexDirectory(directory) {
    directoriesByPath.set(directory.path, directory);
    directory.files.forEach((file) => filesByPath.set(file.path, file));
    directory.directories.forEach(indexDirectory);
  }

  function formatSize(bytes) {
    if (!Number.isFinite(bytes)) return 'unavailable';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function countChanged() {
    return [...filesByPath.values()].filter((file) => file.gitStatus).length;
  }

  function showRuntime(value = null) {
    runtime = value;
    const label = $('#runtimeState');
    label.textContent = value?.busy ? `busy · ${value.busy.type}` : liveState ? 'ready' : 'static';
    label.className = value?.busy ? 'warn' : 'good';
  }

  async function refreshRuntime() {
    if (!liveState) return showRuntime(null);
    try {
      const response = await fetch('/runtime', { cache: 'no-store' });
      if (response.ok) showRuntime(await response.json());
    } catch {}
  }

  function descendants(directory) {
    let count = directory.files.length;
    for (const child of directory.directories) count += descendants(child);
    return count;
  }

  function directorySearchCount(directory) {
    let count = directory.files.reduce((sum, file) => sum + (searchFiles.get(file.path)?.count || 0), 0);
    for (const child of directory.directories) count += directorySearchCount(child);
    return count;
  }

  function applyCamera() {
    world.style.transform = `translate(${camera.x}px,${camera.y}px) scale(${camera.z})`;
  }

  function resetCamera() {
    camera = { x: 48, y: 48, z: 0.92 };
    applyCamera();
  }

  function setZoom(value, clientX = viewport.clientWidth / 2, clientY = viewport.clientHeight / 2) {
    const old = camera.z;
    const next = Math.max(0.45, Math.min(1.8, value));
    camera.x = clientX - (clientX - camera.x) * (next / old);
    camera.y = clientY - (clientY - camera.y) * (next / old);
    camera.z = next;
    applyCamera();
  }

  function renderMissingState() {
    world.innerHTML = '<section class="focus open" style="position:absolute;left:40px;top:40px;transform:none;max-width:620px"><h2 class="focus-title">Repository snapshot required</h2><p class="focus-summary">Run <code>node tools/hud/cli.mjs visual-state</code> from the repository, then refresh this page.</p></section>';
    $('#snapshotState').textContent = 'missing';
    $('#snapshotState').className = 'warn';
  }

  function treeDirectory(directory, depth, fragment) {
    if (directory.path) {
      const row = document.createElement('button');
      const matchCount = directorySearchCount(directory);
      row.className = `tree-row${currentDirectory === directory.path ? ' selected' : ''}${matchCount ? ' search-match' : ''}`;
      row.dataset.directory = directory.path;
      row.dataset.depth = String(depth);
      row.style.paddingLeft = `${8 + depth * 15}px`;
      row.innerHTML = `<span class="twisty">${openDirectories.has(directory.path) ? '▾' : '▸'}</span><span class="folder-dot"></span><span>${directory.name}</span>${matchCount ? `<span class="match-count">${matchCount}</span>` : ''}`;
      fragment.appendChild(row);
      if (!openDirectories.has(directory.path)) return;
    }
    for (const child of directory.directories) treeDirectory(child, depth + (directory.path ? 1 : 0), fragment);
    for (const file of directory.files) {
      const row = document.createElement('button');
      const match = searchFiles.get(file.path);
      row.className = `tree-row${selected?.path === file.path ? ' selected' : ''}${match ? ' search-match' : ''}`;
      row.dataset.file = file.path;
      row.dataset.depth = String(depth + (directory.path ? 1 : 0));
      row.style.paddingLeft = `${23 + (depth + (directory.path ? 1 : 0)) * 15}px`;
      row.innerHTML = `<span class="twisty"></span><span class="file-dot"></span><span>${file.name}</span>${match ? `<span class="match-count">${match.count}</span>` : file.gitStatus ? `<span class="changed">${file.gitStatus.trim() || 'M'}</span>` : ''}`;
      fragment.appendChild(row);
    }
  }

  function renderTree() {
    const fragment = document.createDocumentFragment();
    treeDirectory(repository.root, 0, fragment);
    treeList.replaceChildren(fragment);
  }

  function directoryItems(directory) {
    return [
      ...directory.directories.map((value) => ({ type: 'directory', value })),
      ...directory.files.map((value) => ({ type: 'file', value })),
    ];
  }

  function renderMap() {
    const directory = directoriesByPath.get(currentDirectory) || repository.root;
    const items = directoryItems(directory);
    const columns = Math.max(2, Math.min(5, Math.ceil(Math.sqrt(Math.max(items.length, 1) * 1.45))));
    const cardWidth = 150;
    const cardHeight = 66;
    const gap = 22;
    const regionWidth = Math.max(390, columns * (cardWidth + gap) + 34);
    const rows = Math.max(1, Math.ceil(items.length / columns));
    const regionHeight = Math.max(230, rows * (cardHeight + gap) + 88);
    world.style.width = `${regionWidth + 160}px`;
    world.style.height = `${regionHeight + 160}px`;
    world.innerHTML = '';
    layoutByPath.clear();

    const region = document.createElement('section');
    region.className = 'region';
    region.style.cssText = `left:60px;top:60px;width:${regionWidth}px;height:${regionHeight}px;border-top-color:${palette[Math.abs(currentDirectory.length) % palette.length]}`;
    const parentPath = currentDirectory.includes('/') ? currentDirectory.slice(0, currentDirectory.lastIndexOf('/')) : '';
    region.innerHTML = `<span class="region-title">${directory.path || repository.root.name}</span><span class="region-meta">${directory.directories.length} directories · ${directory.files.length} files</span>`;
    if (directory.path) {
      const back = document.createElement('button');
      back.className = 'node';
      back.dataset.directory = parentPath;
      back.style.cssText = 'left:18px;top:47px;width:70px;min-height:42px';
      back.innerHTML = '<span class="node-name">← parent</span>';
      region.appendChild(back);
    }

    items.forEach((item, index) => {
      const x = 18 + (index % columns) * (cardWidth + gap);
      const y = 106 + Math.floor(index / columns) * (cardHeight + gap);
      const path = item.value.path;
      layoutByPath.set(path, { x: 60 + x, y: 60 + y });
      const button = document.createElement('button');
      button.className = `node${selected?.path === path ? ' selected' : ''}`;
      button.style.cssText = `left:${x}px;top:${y}px;width:${cardWidth}px`;
      if (item.type === 'directory') {
        const matchCount = directorySearchCount(item.value);
        if (matchCount) button.classList.add('search-match');
        button.dataset.directory = path;
        button.innerHTML = `<span class="node-name">▰ ${item.value.name}</span><span class="node-kind">${item.value.directories.length}d · ${item.value.files.length}f · ${descendants(item.value)} total${matchCount ? ` · ${matchCount} matches` : ''}</span>`;
      } else {
        const match = searchFiles.get(path);
        if (match) button.classList.add('search-match');
        button.dataset.file = path;
        button.innerHTML = `<span class="node-name">${item.value.name}</span><span class="node-kind">${item.value.kind} · ${formatSize(item.value.size)}${match ? ` · ${match.count} matches` : ''}</span>${item.value.gitStatus ? '<span class="mark"></span>' : ''}`;
      }
      region.appendChild(button);
    });
    world.appendChild(region);
    applyCamera();
  }

  function enterDirectory(path, reset = true) {
    if (!directoriesByPath.has(path)) return;
    currentDirectory = path;
    openDirectories.add(path);
    let ancestor = path;
    while (ancestor.includes('/')) {
      ancestor = ancestor.slice(0, ancestor.lastIndexOf('/'));
      openDirectories.add(ancestor);
    }
    selected = null;
    $('#selection').textContent = path || 'repository';
    closeFocus();
    renderTree();
    renderMap();
    if (reset) resetCamera();
  }

  function openFile(path, fly = false) {
    const file = filesByPath.get(path);
    if (!file) return;
    selected = file;
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (currentDirectory !== parent) {
      currentDirectory = parent;
      openDirectories.add(parent);
      renderMap();
    }
    renderTree();
    renderMap();
    $('#selection').textContent = file.name;
    $('#focusTitle').textContent = file.name;
    $('#focusPath').textContent = file.path;
    $('#focusSummary').textContent = 'File information from the current Git and filesystem snapshot.';
    renderMedia(file);
    const status = file.gitStatus === '??' ? 'untracked' : file.gitStatus ? file.gitStatus : 'unchanged';
    const match = searchFiles.get(file.path);
    renderSource(file, match);
    $('#focusFacts').innerHTML = `<div class="fact"><div class="fact-label">Type</div><div class="fact-value">${file.kind}</div></div><div class="fact"><div class="fact-label">Size</div><div class="fact-value">${formatSize(file.size)}</div></div><div class="fact"><div class="fact-label">Git</div><div class="fact-value">${status}</div></div>${match ? `<div class="fact search-fact"><div class="fact-label">Search matches</div><div class="fact-value">${match.count}</div></div><div class="fact search-fact"><div class="fact-label">Actual lines</div><div class="fact-value">${match.lines.join(', ')}</div></div>` : ''}`;
    focus.classList.add('open');
    focus.setAttribute('aria-hidden', 'false');
    if (fly) {
      const position = layoutByPath.get(path);
      if (position) {
        camera.z = 1.08;
        camera.x = viewport.clientWidth / 2 - (position.x + 75) * camera.z;
        camera.y = viewport.clientHeight / 2 - (position.y + 34) * camera.z;
        applyCamera();
      }
    }
  }

  function renderMedia(file) {
    const preview = $('#mediaPreview');
    const extension = file.kind.toLowerCase();
    const video = new Set(['mp4', 'mov', 'm4v', 'webm', 'ogv']);
    const audio = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']);
    const image = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
    preview.replaceChildren();
    preview.classList.remove('open');
    if (!video.has(extension) && !audio.has(extension) && !image.has(extension)) return;
    preview.classList.add('open');
    if (!liveState) {
      preview.innerHTML = '<div class="media-note">Media preview requires the read-only <code>hud serve</code> adapter.</div>';
      return;
    }
    const source = `/media?path=${encodeURIComponent(file.path)}`;
    let element;
    if (video.has(extension)) {
      element = document.createElement('video');
      element.controls = true;
      element.preload = 'metadata';
      element.playsInline = true;
    } else if (audio.has(extension)) {
      element = document.createElement('audio');
      element.controls = true;
      element.preload = 'metadata';
    } else {
      element = document.createElement('img');
      element.alt = file.name;
      element.loading = 'lazy';
    }
    element.src = source;
    preview.appendChild(element);
    const note = document.createElement('div');
    note.className = 'media-note';
    note.textContent = video.has(extension)
      ? 'Playback depends on browser support for the codecs inside this file.'
      : `${extension.toUpperCase()} repository preview`;
    preview.appendChild(note);
  }

  async function renderSource(file, match) {
    const preview = $('#sourcePreview');
    preview.replaceChildren();
    preview.classList.remove('open');
    if (!match) return;
    preview.classList.add('open');
    if (!liveState) {
      preview.innerHTML = '<div class="media-note">Source excerpts require the live local HUD runtime.</div>';
      return;
    }
    preview.innerHTML = '<div class="media-note">Loading factual source context…</div>';
    try {
      const run = activeSearchRunId ? `&run=${encodeURIComponent(activeSearchRunId)}` : '';
      const response = await fetch(`/source?path=${encodeURIComponent(file.path)}&context=2${run}`, { cache: 'no-store' });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `Source request failed with HTTP ${response.status}.`);
      if (selected?.path !== file.path) return;
      preview.replaceChildren();
      const head = document.createElement('div');
      head.className = 'source-head';
      const label = document.createElement('span');
      label.textContent = `SEARCH ${value.query} · run:${value.runId}`;
      const evidence = document.createElement('strong');
      evidence.textContent = value.evidence;
      const navigation = document.createElement('div');
      navigation.className = 'source-navigation';
      const position = searchOrder.indexOf(file.path);
      const previous = document.createElement('button');
      previous.type = 'button';
      previous.className = 'source-nav';
      previous.setAttribute('aria-label', 'Previous matching file');
      previous.textContent = '←';
      previous.disabled = position <= 0;
      previous.onclick = () => openFile(searchOrder[position - 1], true);
      const count = document.createElement('span');
      count.textContent = `${position + 1}/${searchOrder.length}`;
      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'source-nav';
      next.setAttribute('aria-label', 'Next matching file');
      next.textContent = '→';
      next.disabled = position < 0 || position >= searchOrder.length - 1;
      next.onclick = () => openFile(searchOrder[position + 1], true);
      navigation.append(previous, count, next);
      head.append(label, evidence, navigation);
      const code = document.createElement('div');
      code.className = 'source-code';
      value.excerpts.forEach((excerpt, excerptIndex) => {
        if (excerptIndex) {
          const separator = document.createElement('div');
          separator.className = 'source-separator';
          code.appendChild(separator);
        }
        excerpt.lines.forEach((line) => {
          const row = document.createElement('div');
          row.className = `source-line${line.match ? ' match' : ''}`;
          const number = document.createElement('span');
          number.className = 'source-number';
          number.textContent = String(line.number);
          const text = document.createElement('span');
          text.textContent = line.text;
          row.append(number, text);
          code.appendChild(row);
        });
      });
      preview.append(head, code);
    } catch (error) {
      if (selected?.path !== file.path) return;
      preview.innerHTML = '<div class="media-note"></div>';
      preview.querySelector('.media-note').textContent = error.message;
    }
  }

  function closeFocus() {
    focus.classList.remove('open');
    focus.setAttribute('aria-hidden', 'true');
  }

  function resolved(command) {
    return command
      .replaceAll('{selection}', selected?.path || '[select a file]')
      .replaceAll('{current}', currentDirectory || '.');
  }

  function typedSearch(value) {
    const match = String(value || '').match(/^search\s+(?:"([^"]*)"|'([^']*)'|(\S+))(?:\s+(\S+))?\s*$/i);
    if (!match) return null;
    const query = match[1] ?? match[2] ?? match[3];
    return query ? { query, scope: match[4] || '.' } : null;
  }

  function enterSearchMode(scope = '.') {
    inputMode = 'search';
    $('#terminal').classList.add('search-mode');
    $('.prompt').textContent = '?';
    input.value = '';
    input.placeholder = 'Search literal text';
    input.setAttribute('aria-label', 'Search query');
    const scopeInput = $('#searchScope');
    const current = currentDirectory || '.';
    scopeInput.replaceChildren();
    for (const [value, label] of [['.', 'Repository'], [current, `Current · ${current}`]]) {
      if ([...scopeInput.options].some((option) => option.value === value)) continue;
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      scopeInput.appendChild(option);
    }
    scopeInput.value = scope === '{current}' ? current : scope;
    previewInput();
    input.focus();
  }

  function exitSearchMode() {
    inputMode = 'terminal';
    $('#terminal').classList.remove('search-mode');
    $('.prompt').textContent = '$';
    input.value = '';
    input.placeholder = 'Enter or discover an exact command';
    input.setAttribute('aria-label', 'Terminal command');
    $('.run').disabled = false;
    $('.run').textContent = 'Copy';
    input.focus();
  }

  function previewInput() {
    const operation = inputMode === 'search'
      ? input.value.trim() ? { query: input.value, scope: $('#searchScope').value || '.' } : null
      : typedSearch(input.value);
    const searchIntent = inputMode === 'search' || /^\s*search(?:\s|$)/i.test(input.value);
    $('.run').disabled = searchIntent && !operation;
    $('.run').textContent = searchIntent ? 'Search' : 'Copy';
    if (!operation) {
      if (searchIntent) {
        output.classList.add('open');
        $('#outputTitle').textContent = 'Complete the Search request';
        $('#outputText').textContent = inputMode === 'search'
          ? 'Enter the literal text to find, then choose Repository or Current Directory.'
          : 'Enter a query in quotes, followed by a repository scope.\n\nExample: search "current state" tools/hud';
        $('#outputResults').replaceChildren();
      }
      return;
    }
    output.classList.add('open');
    $('#outputTitle').textContent = liveState ? 'Typed local operation' : 'Static operation preview';
    $('#outputText').textContent = `SEARCH\nQUERY ${operation.query}\nSCOPE ${operation.scope}\n\n${liveState ? 'The local runtime will select and record the exact search primitive.' : 'Snapshot mode cannot execute. The equivalent CLI command will be copied.'}`;
    $('#outputResults').replaceChildren();
  }

  function renderPicker() {
    const list = $('#pickerList');
    list.replaceChildren();
    renderedCommands = [];
    const query = $('#pickerSearch').value.toLowerCase();
    for (const [section, commandsInSection] of Object.entries(commands)) {
      const matching = commandsInSection.filter((command) => !query || command.join(' ').toLowerCase().includes(query));
      if (!matching.length) continue;
      const expanded = Boolean(query) || openMenuSections.has(section);
      const heading = document.createElement('button');
      heading.type = 'button';
      heading.className = 'command-section';
      heading.dataset.section = section;
      heading.setAttribute('aria-expanded', String(expanded));
      heading.textContent = `${expanded ? '▾' : '▸'} ${section}`;
      list.appendChild(heading);
      if (!expanded) continue;
      for (const command of matching) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'command-item';
        button.dataset.command = renderedCommands.push(command) - 1;
        for (const [className, text] of [['command-name', command[0]], ['scope', command[3]], ['command-desc', command[1]], ['command-code', resolved(command[2])]]) {
          const element = document.createElement('span');
          element.className = className;
          element.textContent = text;
          button.appendChild(element);
        }
        list.appendChild(button);
      }
    }
  }

  function togglePicker(force) {
    const open = force ?? !picker.classList.contains('open');
    picker.classList.toggle('open', open);
    toolkit.setAttribute('aria-expanded', String(open));
    if (open) {
      renderPicker();
      setTimeout(() => $('#pickerSearch').focus(), 20);
    } else input.focus();
  }

  async function stageCommand(command) {
    if (!command.trim()) return;
    let copied = false;
    try {
      await navigator.clipboard.writeText(command);
      copied = true;
    } catch {}
    output.classList.add('open');
    $('#outputActions').replaceChildren();
    $('#outputActions').classList.remove('open');
    $('#outputTitle').textContent = 'Exact command';
    $('#outputText').textContent = `$ ${command}\n\n${copied ? 'Copied to the clipboard.' : 'Ready to copy.'}\nThis static browser client does not execute host shell commands.`;
    $('#outputResults').replaceChildren();
  }

  async function copyHandoff() {
    if (!liveState) return stageCommand('node tools/hud/cli.mjs handoff --copy');
    output.classList.add('open');
    $('#outputActions').replaceChildren();
    $('#outputActions').classList.remove('open');
    $('#outputTitle').textContent = 'Compact operation handoff';
    $('#outputText').textContent = 'Loading the last structured operation…';
    $('#outputResults').replaceChildren();
    try {
      const response = await fetch('/handoff', { cache: 'no-store' });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `Handoff request failed with HTTP ${response.status}.`);
      let copied = false;
      try { await navigator.clipboard.writeText(value.handoff); copied = true; } catch {}
      $('#outputText').textContent = `${value.handoff}\n\n${copied ? 'Copied to the clipboard.' : 'Ready to copy.'}`;
    } catch (error) {
      $('#outputText').textContent = error.message;
    }
  }

  function renderSearchResults(value, runId = activeSearchRunId || state.last?.runId) {
    $('#outputText').textContent = `${value.command}\n\n${value.matchCount} matches in ${value.fileCount} files\n\nRaw evidence: run:${runId || 'unknown'}`;
    const results = $('#outputResults');
    results.replaceChildren();
    value.files.forEach((file) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'output-result';
      const path = document.createElement('span');
      path.textContent = file.path;
      const count = document.createElement('strong');
      count.textContent = String(file.count);
      const lines = document.createElement('small');
      lines.textContent = `lines ${file.lines.join(',')}`;
      button.append(path, count, lines);
      button.onclick = () => {
        output.classList.remove('open');
        openFile(file.path, true);
      };
      results.appendChild(button);
    });
  }

  async function copyRecordedHandoff(detail) {
    let copied = false;
    try { await navigator.clipboard.writeText(detail.handoff); copied = true; } catch {}
    $('#outputText').textContent += copied ? '\n\nHandoff copied.' : '\n\nHandoff is ready but clipboard access was unavailable.';
  }

  function appendEvidenceActions(actions, runId) {
    actions.append(
      outputAction('Raw stdout', '', () => showEvidence(runId, 'stdout')),
      outputAction('Raw stderr', '', () => showEvidence(runId, 'stderr')),
    );
  }

  async function showEvidence(runId, stream) {
    output.classList.add('open');
    $('#outputTitle').textContent = `Loading ${stream}`;
    $('#outputText').textContent = `run:${runId}`;
    $('#outputResults').replaceChildren();
    const actions = $('#outputActions');
    actions.replaceChildren();
    actions.classList.remove('open');
    try {
      const response = await fetch(`/history/${encodeURIComponent(runId)}/evidence/${stream}?tail=200`, { cache: 'no-store' });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `Evidence request failed with HTTP ${response.status}.`);
      $('#outputTitle').textContent = `${stream.toUpperCase()} · run:${runId}`;
      $('#outputText').textContent = `${value.size} bytes · ${value.complete ? 'complete' : 'bounded tail'}\n\n${value.text || '(empty)'}`;
      actions.replaceChildren(outputAction('Back to operation', '', () => showHistoryDetail(runId)));
      actions.classList.add('open');
    } catch (error) {
      $('#outputTitle').textContent = 'Evidence unavailable';
      $('#outputText').textContent = error.message;
    }
  }

  function activateRecordedSearch(detail) {
    search = detail.operation;
    activeSearchRunId = detail.runId;
    searchFiles.clear();
    searchOrder.splice(0);
    for (const file of search.files || []) {
      searchFiles.set(file.path, file);
      searchOrder.push(file.path);
    }
    closeFocus();
    if (search.scope && search.scope !== '.' && directoriesByPath.has(search.scope)) enterDirectory(search.scope);
    else { currentDirectory = ''; renderTree(); renderMap(); }
    $('#searchState').textContent = `${search.matchCount} / ${search.fileCount}`;
    $('#searchState').className = search.matchCount ? 'search-text' : 'good';
    output.classList.add('open');
    $('#outputTitle').textContent = `Recorded Search · ${detail.evidence}`;
    renderSearchResults(search, detail.runId);
    const actions = $('#outputActions');
    actions.replaceChildren(outputAction('Copy handoff', 'confirm', () => copyRecordedHandoff(detail)));
    appendEvidenceActions(actions, detail.runId);
    actions.classList.add('open');
  }

  async function showHistoryDetail(runId) {
    $('#outputTitle').textContent = 'Loading recorded operation';
    $('#outputText').textContent = `run:${runId}`;
    $('#outputResults').replaceChildren();
    try {
      const response = await fetch(`/history/${encodeURIComponent(runId)}`, { cache: 'no-store' });
      const detail = await response.json();
      if (!response.ok) throw new Error(detail.error || `History request failed with HTTP ${response.status}.`);
      if (detail.operation.type === 'search') return activateRecordedSearch(detail);
      $('#outputTitle').textContent = `${detail.operation.name} · ${detail.evidence}`;
      const summary = detail.status === 'interrupted'
        ? 'Completion was not observed; retained output may be partial.'
        : detail.operation.summary?.join('; ') || `exit ${detail.operation.exitCode}`;
      $('#outputText').textContent = `${detail.operation.command}\n\n${detail.status.toUpperCase()} · ${summary}\n${(detail.durationMs / 1000).toFixed(1)}s\nRaw evidence: run:${detail.runId}`;
      const actions = $('#outputActions');
      actions.replaceChildren(outputAction('Copy handoff', '', () => copyRecordedHandoff(detail)));
      appendEvidenceActions(actions, detail.runId);
      const planResponse = await fetch(`/undo/${encodeURIComponent(detail.runId)}`, { cache: 'no-store' });
      const plan = await planResponse.json();
      if (planResponse.ok && plan.state === 'SAFE') {
        actions.appendChild(outputAction(detail.operation.type === 'undo' ? 'Redo' : 'Undo', 'confirm', () => confirmUndo(detail, plan)));
      } else if (planResponse.ok && plan.state === 'CONFLICT') {
        $('#outputText').textContent += `\n\nUNDO CONFLICT\n${plan.reason}`;
      }
      actions.classList.add('open');
    } catch (error) {
      $('#outputTitle').textContent = 'History unavailable';
      $('#outputText').textContent = error.message;
    }
  }

  function confirmUndo(detail, plan) {
    const verb = detail.operation.type === 'undo' ? 'Redo' : 'Undo';
    $('#outputTitle').textContent = `Confirm ${verb}`;
    const shown = plan.paths.slice(0, 12);
    const remainder = plan.paths.length - shown.length;
    $('#outputText').textContent = `${verb.toUpperCase()} run:${detail.runId}\n\n${plan.reason}\n\nFILES\n${shown.join('\n')}${remainder > 0 ? `\n… and ${remainder} more` : ''}\n\nThis creates a new recorded inverse operation. It does not erase history.`;
    $('#outputResults').replaceChildren();
    const actions = $('#outputActions');
    actions.replaceChildren(
      outputAction('Cancel', '', () => showHistoryDetail(detail.runId)),
      outputAction(`Apply ${verb}`, 'confirm', () => executeUndo(detail.runId, verb)),
    );
    actions.classList.add('open');
  }

  async function executeUndo(runId, verb) {
    const actions = $('#outputActions');
    actions.replaceChildren();
    actions.classList.remove('open');
    $('#outputTitle').textContent = `${verb} running`;
    $('#outputText').textContent = `Safely applying the recorded inverse for run:${runId}…`;
    showRuntime({ busy: { type: 'undo' } });
    try {
      const response = await fetch('/operations/undo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId }),
      });
      const result = await response.json();
      if (!response.ok) { if (result.busy) showRuntime({ busy: result.busy }); throw new Error(result.error || `${verb} failed with HTTP ${response.status}.`); }
      state = result.state;
      $('#outputTitle').textContent = `${verb} ${result.status}`;
      $('#outputText').textContent = `${result.operation.fileCount} files restored\n${(result.operation.durationMs / 1000).toFixed(1)}s\n\n${result.operation.paths.join('\n')}\n\nRaw evidence: run:${result.runId}`;
      $('#snapshotState').textContent = state.git.head.slice(0, 7);
      $('#snapshotState').className = state.git.dirty ? 'warn' : 'good';
      $('#changeCount').textContent = String(state.git.changedFiles.length);
      $('#changeCount').className = state.git.changedFiles.length ? 'warn' : 'good';
      actions.replaceChildren(
        outputAction('Copy handoff', '', copyHandoff),
        outputAction('Refresh repository', 'confirm', () => window.location.reload()),
      );
      appendEvidenceActions(actions, result.runId);
      actions.classList.add('open');
      showRuntime({ busy: null });
    } catch (error) {
      $('#outputTitle').textContent = `${verb} refused`;
      $('#outputText').textContent = error.message;
      refreshRuntime();
    }
  }

  async function showLatestUndo() {
    output.classList.add('open');
    $('#outputTitle').textContent = 'Finding latest reversible operation';
    $('#outputText').textContent = liveState ? 'Checking immutable history…' : 'Undo requires the live local HUD runtime.';
    $('#outputResults').replaceChildren();
    if (!liveState) return;
    try {
      const response = await fetch('/history?limit=25', { cache: 'no-store' });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `History request failed with HTTP ${response.status}.`);
      const latest = value.history.find((item) => item.reversible);
      if (!latest) {
        $('#outputTitle').textContent = 'Nothing to undo';
        $('#outputText').textContent = 'No recorded operation has a content-level worktree change.';
        return;
      }
      const [detailResponse, planResponse] = await Promise.all([
        fetch(`/history/${encodeURIComponent(latest.runId)}`, { cache: 'no-store' }),
        fetch(`/undo/${encodeURIComponent(latest.runId)}`, { cache: 'no-store' }),
      ]);
      const detail = await detailResponse.json();
      const plan = await planResponse.json();
      if (!detailResponse.ok || !planResponse.ok) throw new Error(detail.error || plan.error || 'Unable to prepare Undo.');
      if (plan.state === 'SAFE') confirmUndo(detail, plan);
      else {
        $('#outputTitle').textContent = `Undo ${plan.state.toLowerCase()}`;
        $('#outputText').textContent = `${plan.reason}\n\n${plan.paths.join('\n')}`;
      }
    } catch (error) {
      $('#outputTitle').textContent = 'Undo unavailable';
      $('#outputText').textContent = error.message;
    }
  }

  async function showHistory() {
    output.classList.add('open');
    $('#outputTitle').textContent = 'Operation history';
    $('#outputText').textContent = liveState ? 'Loading immutable operation records…' : 'History requires the live local HUD runtime.';
    $('#outputResults').replaceChildren();
    $('#outputActions').replaceChildren();
    $('#outputActions').classList.remove('open');
    if (!liveState) return;
    try {
      const response = await fetch('/history?limit=25', { cache: 'no-store' });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `History request failed with HTTP ${response.status}.`);
      $('#outputText').textContent = value.history.length ? `${value.history.length} recorded operations` : 'No structured operations have been recorded.';
      for (const item of value.history) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'output-result';
        const label = document.createElement('span');
        label.textContent = item.type === 'search' ? `Search ${item.query}` : item.name;
        const status = document.createElement('strong');
        status.textContent = item.status.toUpperCase();
        const result = document.createElement('small');
        result.textContent = `${item.result} · ${item.evidence} · ${(item.durationMs / 1000).toFixed(1)}s`;
        button.append(label, status, result);
        button.onclick = () => showHistoryDetail(item.runId);
        $('#outputResults').appendChild(button);
      }
    } catch (error) {
      $('#outputTitle').textContent = 'History unavailable';
      $('#outputText').textContent = error.message;
    }
  }

  async function executeSearch(operation) {
    output.classList.add('open');
    $('#outputActions').replaceChildren();
    $('#outputActions').classList.remove('open');
    $('#outputTitle').textContent = 'Search running';
    $('#outputText').textContent = `SEARCH\nQUERY ${operation.query}\nSCOPE ${operation.scope}\n\nWaiting for the local runtime…`;
    $('.run').disabled = true;
    showRuntime({ busy: { type: 'search' } });
    try {
      const response = await fetch('/operations/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(operation),
      });
      const result = await response.json();
      if (!response.ok) { if (result.busy) showRuntime({ busy: result.busy }); throw new Error(result.error || `Search request failed with HTTP ${response.status}.`); }
      $('#outputTitle').textContent = `Search ${result.status}`;
      $('#outputText').textContent = `${result.operation.command}\n\n${result.operation.matchCount} matches in ${result.operation.fileCount} files\nRaw evidence: run:${result.runId}\n\nRefreshing repository state…`;
      window.setTimeout(() => window.location.reload(), 250);
    } catch (error) {
      $('#outputTitle').textContent = 'Search rejected';
      $('#outputText').textContent = error.message;
      $('.run').disabled = false;
      refreshRuntime();
    }
  }

  function outputAction(label, className, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.onclick = handler;
    return button;
  }

  function confirmRepositoryCommand(command) {
    if (inputMode === 'search') exitSearchMode();
    input.value = command[2];
    togglePicker(false);
    previewInput();
    if (!liveState) return stageCommand(command[2]);
    output.classList.add('open');
    $('#outputTitle').textContent = 'Confirm repository command';
    $('#outputText').textContent = `${command[0]}\n${command[2]}\n\nThis command is declared by the repository and can execute arbitrary local code.`;
    $('#outputResults').replaceChildren();
    const actions = $('#outputActions');
    actions.replaceChildren(
      outputAction('Cancel', '', () => output.classList.remove('open')),
      outputAction('Run', 'confirm', () => executeRepositoryCommand(command[4])),
    );
    actions.classList.add('open');
  }

  async function cancelActiveRun(runId) {
    $('#outputTitle').textContent = 'Cancelling repository command';
    showRuntime({ busy: { type: 'repository-command', state: 'cancelling', runId } });
    try {
      const response = await fetch('/operations/cancel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `Cancel failed with HTTP ${response.status}.`);
      const actions = $('#outputActions');
      actions.replaceChildren(outputAction('Cancelling…', '', () => {}));
      actions.firstChild.disabled = true;
    } catch (error) {
      $('#outputTitle').textContent = 'Cancel refused';
      $('#outputText').textContent += `\n\n${error.message}`;
      refreshRuntime();
    }
  }

  async function monitorRepositoryCommand(control) {
    while (!control.done) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (control.done) return;
      try {
        const response = await fetch('/runtime', { cache: 'no-store' });
        if (!response.ok) continue;
        const value = await response.json();
        showRuntime(value);
        const active = value.busy;
        if (!active?.runId || active.type !== 'repository-command') continue;
        const evidenceResponse = await fetch(`/runtime/evidence/stdout?run=${encodeURIComponent(active.runId)}&tail=80`, { cache: 'no-store' });
        const evidence = evidenceResponse.ok ? await evidenceResponse.json() : null;
        if (control.done) return;
        const elapsed = Math.max(0, Date.now() - Date.parse(active.startedAt || new Date().toISOString()));
        $('#outputTitle').textContent = active.state === 'cancelling' ? 'Repository command cancelling' : 'Repository command running';
        $('#outputText').textContent = `${active.command || active.label}\n\n${(elapsed / 1000).toFixed(1)}s · ${active.state.toUpperCase()}\n\n${evidence?.text || 'Waiting for output…'}`;
        const actions = $('#outputActions');
        if (active.cancellable && active.state === 'running') {
          actions.replaceChildren(outputAction('Cancel', 'confirm', () => cancelActiveRun(active.runId)));
          actions.classList.add('open');
        }
      } catch {}
    }
  }

  async function executeRepositoryCommand(name) {
    const actions = $('#outputActions');
    actions.replaceChildren();
    actions.classList.remove('open');
    $('#outputTitle').textContent = 'Repository command running';
    $('#outputText').textContent = `${name}\n\nWaiting for the local runtime…`;
    showRuntime({ busy: { type: 'repository-command' } });
    const monitor = { done: false };
    monitorRepositoryCommand(monitor);
    try {
      const response = await fetch('/operations/repository-command', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      monitor.done = true;
      const result = await response.json();
      if (!response.ok) { if (result.busy) showRuntime({ busy: result.busy }); throw new Error(result.error || `Repository command failed with HTTP ${response.status}.`); }
      state = result.state;
      const summary = result.status === 'cancelled'
        ? 'Cancelled by user'
        : result.operation.summary.length ? result.operation.summary.join('; ') : `exit ${result.operation.exitCode}`;
      $('#outputTitle').textContent = `${result.operation.name} ${result.status}`;
      $('#outputText').textContent = `${result.operation.command}\n\n${summary}\n${(result.operation.durationMs / 1000).toFixed(1)}s\nRaw evidence: run:${result.runId}`;
      $('#snapshotState').textContent = state.git.head.slice(0, 7);
      $('#snapshotState').className = state.git.dirty ? 'warn' : 'good';
      $('#changeCount').textContent = String(state.git.changedFiles.length);
      $('#changeCount').className = state.git.changedFiles.length ? 'warn' : 'good';
      $('#searchState').textContent = 'none';
      $('#searchState').className = '';
      document.querySelectorAll('.search-match').forEach((element) => element.classList.remove('search-match'));
      actions.replaceChildren(outputAction('Copy handoff', 'confirm', copyHandoff));
      appendEvidenceActions(actions, result.runId);
      if (result.status === 'cancelled') {
        const [detailResponse, planResponse] = await Promise.all([
          fetch(`/history/${encodeURIComponent(result.runId)}`, { cache: 'no-store' }),
          fetch(`/undo/${encodeURIComponent(result.runId)}`, { cache: 'no-store' }),
        ]);
        if (detailResponse.ok && planResponse.ok) {
          const detail = await detailResponse.json();
          const plan = await planResponse.json();
          if (plan.state === 'SAFE') actions.appendChild(outputAction('Undo partial changes', 'confirm', () => confirmUndo(detail, plan)));
        }
      }
      actions.classList.add('open');
      showRuntime({ busy: null });
    } catch (error) {
      monitor.done = true;
      $('#outputTitle').textContent = 'Repository command rejected';
      $('#outputText').textContent = error.message;
      refreshRuntime();
    }
  }

  if (!repository?.root) {
    renderMissingState();
    return;
  }

  indexDirectory(repository.root);
  if (search?.scope && search.scope !== '.' && directoriesByPath.has(search.scope)) {
    currentDirectory = search.scope;
    openDirectories.add(search.scope);
  }
  $('.brand').textContent = state.project.name;
  $('.branch').textContent = state.git.branch;
  $('#branchValue').textContent = state.git.branch;
  $('#fileCount').textContent = String(repository.fileCount);
  $('#changeCount').textContent = String(countChanged());
  $('#changeCount').className = countChanged() ? 'warn' : 'good';
  $('#snapshotState').textContent = state.git.head.slice(0, 7);
  $('#snapshotState').className = state.git.dirty ? 'warn' : 'good';
  showRuntime(runtime);
  if (search) {
    $('#searchState').textContent = `${search.matchCount} / ${search.fileCount}`;
    $('#searchState').className = search.matchCount ? 'search-text' : 'good';
    output.classList.add('open');
    $('#outputTitle').textContent = `Search: ${search.query}`;
    renderSearchResults(search);
    if (activeSearchRunId) {
      const actions = $('#outputActions');
      appendEvidenceActions(actions, activeSearchRunId);
      actions.classList.add('open');
    }
  }

  treeList.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.directory !== undefined) {
      const path = button.dataset.directory;
      if (openDirectories.has(path)) openDirectories.delete(path);
      else openDirectories.add(path);
      enterDirectory(path);
    } else if (button.dataset.file) openFile(button.dataset.file, true);
  });

  world.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.directory !== undefined) enterDirectory(button.dataset.directory);
    else if (button.dataset.file) openFile(button.dataset.file);
  });

  viewport.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button') || event.target.closest('.focus')) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewport.setPointerCapture(event.pointerId);
    if (pointers.size === 1) gesture = { kind: 'pan', x: event.clientX, y: event.clientY, camera: { ...camera }, moved: false };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { kind: 'pinch', distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: camera.z };
    }
    viewport.classList.add('dragging');
  });
  viewport.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (gesture?.kind === 'pan' && pointers.size === 1) {
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      gesture.moved ||= Math.hypot(dx, dy) > 4;
      camera.x = gesture.camera.x + dx;
      camera.y = gesture.camera.y + dy;
      applyCamera();
    } else if (gesture?.kind === 'pinch' && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      setZoom(gesture.zoom * Math.hypot(a.x - b.x, a.y - b.y) / gesture.distance, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
  });
  const finishPointer = (event) => {
    const wasClick = gesture?.kind === 'pan' && !gesture.moved;
    pointers.delete(event.pointerId);
    if (!pointers.size) {
      viewport.classList.remove('dragging');
      gesture = null;
      if (wasClick) closeFocus();
    }
  };
  viewport.addEventListener('pointerup', finishPointer);
  viewport.addEventListener('pointercancel', finishPointer);
  viewport.addEventListener('wheel', (event) => {
    event.preventDefault();
    setZoom(camera.z * (event.deltaY > 0 ? 0.9 : 1.1), event.offsetX, event.offsetY);
  }, { passive: false });

  $('#treeToggle').addEventListener('click', () => {
    const closed = app.classList.toggle('tree-closed');
    $('#treeToggle').setAttribute('aria-expanded', String(!closed));
  });
  $('#zoomIn').onclick = () => setZoom(camera.z * 1.15);
  $('#zoomOut').onclick = () => setZoom(camera.z * 0.87);
  $('#zoomReset').onclick = resetCamera;
  $('#focusClose').onclick = closeFocus;
  $('.actions').onclick = (event) => {
    if (!event.target.dataset.action || !selected) return;
    input.value = event.target.dataset.action === 'changes' ? `git diff -- ${selected.path}` : `code --goto ${selected.path}`;
    closeFocus();
    input.focus();
  };
  toolkit.onclick = () => togglePicker();
  $('#pickerSearch').oninput = renderPicker;
  $('#pickerList').onclick = (event) => {
    const sectionButton = event.target.closest('[data-section]');
    if (sectionButton) {
      const section = sectionButton.dataset.section;
      if (openMenuSections.has(section)) openMenuSections.delete(section);
      else openMenuSections.add(section);
      renderPicker();
      return;
    }
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const chosen = renderedCommands[Number(button.dataset.command)];
    if (!chosen) return;
    const action = chosen[5];
    if (action) togglePicker(false);
    if (action === 'handoff') return copyHandoff();
    if (action === 'history') return showHistory();
    if (action === 'undo') return showLatestUndo();
    if (action === 'refresh') return window.location.reload();
    if (action === 'search-repository' || action === 'search-current') return enterSearchMode(action === 'search-current' ? '{current}' : '.');
    if (chosen[4]) {
      confirmRepositoryCommand(chosen);
      return;
    }
    input.value = resolved(chosen[2]);
    togglePicker(false);
    previewInput();
    if (input.value.includes('""')) input.setSelectionRange(8, 8);
  };
  input.addEventListener('input', previewInput);
  $('#searchScope').addEventListener('change', previewInput);
  $('#inputMode').addEventListener('click', exitSearchMode);
  $('#terminal').onsubmit = async (event) => {
    event.preventDefault();
    togglePicker(false);
    const operation = inputMode === 'search'
      ? input.value.trim() ? { query: input.value, scope: $('#searchScope').value || '.' } : null
      : typedSearch(input.value);
    if (liveState && operation) await executeSearch(operation);
    else if (!liveState && operation) await stageCommand(`node tools/hud/cli.mjs search ${JSON.stringify(operation.query)} ${operation.scope}`);
    else await stageCommand(input.value);
  };
  $('#outputClose').onclick = () => output.classList.remove('open');
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (picker.classList.contains('open')) togglePicker(false);
      else if (output.classList.contains('open')) output.classList.remove('open');
      else if (focus.classList.contains('open')) closeFocus();
      else if (inputMode === 'search') exitSearchMode();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      togglePicker();
    }
  });

  renderTree();
  renderMap();
  renderPicker();
  if (window.innerWidth <= 640) {
    app.classList.add('tree-closed');
    $('#treeToggle').setAttribute('aria-expanded', 'false');
  }
  window.commandHudDemo = {
    enterDirectory,
    openFile,
    closeFocus,
    togglePicker,
    getState: () => ({ currentDirectory, selected: selected?.path || null, camera: { ...camera } }),
    getSearch: () => search,
  };
})();

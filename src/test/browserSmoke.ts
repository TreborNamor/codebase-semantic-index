import * as vscode from 'vscode';

const TOOL = 'codebase_semantic_index_search';
const INITIAL = 'smokeInitialWorkspaceMarker';
const REPLACEMENT = 'smokeReplacementCheckoutMarker';
const UNSAVED = 'smokeUnsavedBufferMarker';

function assert(value: unknown, message: string): asserts value {
	if (!value) { throw new Error(message); }
}

async function eventually(check: () => Promise<boolean>, message: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	do {
		if (await check()) { return; }
		await new Promise(resolve => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	throw new Error(message);
}

async function search(query: string): Promise<string> {
	const cancellation = new vscode.CancellationTokenSource();
	const timer = setTimeout(() => cancellation.cancel(), 10_000);
	try {
		const result = await vscode.lm.invokeTool(TOOL, {
			input: { query, pathPrefix: 'sample.ts', maxResults: 5 },
			toolInvocationToken: undefined,
		}, cancellation.token);
		return result.content.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
			.map(part => part.value).join('\n');
	} finally { clearTimeout(timer); cancellation.dispose(); }
}

async function smoke(): Promise<void> {
	const extension = vscode.extensions.getExtension('TreborNamor.codebase-semantic-index');
	assert(extension, 'The actual development extension must be installed in the web extension host.');
	await extension.activate();
	assert(vscode.lm.tools.some(tool => tool.name === TOOL), 'The extension must register its public search tool.');
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	assert(root && root.scheme === 'vscode-test-web', 'Smoke tests require the in-memory test-web fixture filesystem.');
	const file = vscode.Uri.joinPath(root, 'sample.ts');
	const ignore = vscode.Uri.joinPath(root, '.gitignore');
	const encode = (text: string) => new TextEncoder().encode(text);

	let result = await search(INITIAL);
	assert(result.includes(INITIAL), 'Saved fixture contents must be discoverable through vscode.lm.invokeTool.');
	console.log('[browser smoke] actual extension activation and saved-file search passed');

	// test-web stores these mutations in memory; the checked-in fixture is never changed.
	await vscode.workspace.fs.writeFile(file, encode(`export const ${REPLACEMENT} = 'current checkout';\n`));
	result = await search(REPLACEMENT);
	assert(result.includes(REPLACEMENT) && !result.includes(INITIAL), 'Same-path replacement must suppress the previous checkout contents.');
	assert(!(await search(INITIAL)).includes(INITIAL), 'Previous checkout marker must not survive in stored previews.');
	console.log('[browser smoke] same-name checkout replacement passed');

	await eventually(async () => (await vscode.workspace.openTextDocument(file)).getText().includes(REPLACEMENT),
		'The live TextDocument did not refresh after filesystem replacement.');
	const doc = await vscode.workspace.openTextDocument(file);
	await vscode.window.showTextDocument(doc);
	const edit = new vscode.WorkspaceEdit();
	edit.replace(file, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
		`export const ${UNSAVED} = 'editor buffer';\n`);
	assert(await vscode.workspace.applyEdit(edit), 'WorkspaceEdit must modify the current document.');
	assert(doc.isDirty && doc.getText().includes(UNSAVED), 'The test must exercise a genuinely unsaved buffer.');
	assert(!(new TextDecoder().decode(await vscode.workspace.fs.readFile(file))).includes(UNSAVED),
		'Unsaved content must not have been written to the provider.');
	result = await search(UNSAVED);
	assert(result.includes(UNSAVED) && !result.includes(REPLACEMENT), 'Search must use the live dirty buffer instead of saved/indexed contents.');
	console.log('[browser smoke] unsaved editor-buffer retrieval passed');

	await vscode.workspace.fs.writeFile(ignore, encode('sample.ts\n'));
	assert(!(await search(UNSAVED)).includes(UNSAVED), 'A newly ignored file must disappear even while its editor is dirty.');
	await vscode.workspace.fs.delete(ignore);
	assert((await search(UNSAVED)).includes(UNSAVED), 'Removing the ignore rule must restore the current live source.');
	await vscode.workspace.fs.delete(file);
	assert(!(await search(UNSAVED)).includes(UNSAVED), 'Deleted files must not return stored previews or lingering editor buffers.');
	console.log('[browser smoke] ignore changes and deletion suppression passed');

	// These commands exercise both actual webview providers. Cross-origin webview DOM/model inference
	// is not asserted here; model-host requests are deliberately blocked by the Node test runner.
	await vscode.commands.executeCommand('codebase-semantic-index.panel.focus');
	await vscode.commands.executeCommand('codebaseSemanticIndex.refinePrompt');
	await vscode.commands.executeCommand('codebase-semantic-index.worker.focus');
	console.log('[browser smoke] panel, prompt-refiner, and worker focus commands resolved');
	console.log('[browser smoke] PASS (current-file lexical fallback; model inference was not tested)');
}

/** Called by @vscode/test-web in a real web extension host. */
export async function run(): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			smoke(),
			new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Browser smoke suite exceeded 60 seconds.')), 60_000); }),
		]);
	} finally { if (timer) { clearTimeout(timer); } }
}

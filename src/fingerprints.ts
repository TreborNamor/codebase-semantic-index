/** Browser-compatible identity for source content, independent of Git history. */
export async function hashText(text: string): Promise<string> {
	return hashBytes(new TextEncoder().encode(text));
}

export async function hashBytes(bytes: Uint8Array): Promise<string> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	const digest = await crypto.subtle.digest('SHA-256', copy);
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

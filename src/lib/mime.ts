export type Kind = 'text' | 'image';

const TEXT_EXT = new Set(['txt', 'md', 'csv', 'json', 'log', 'xml', 'yaml', 'yml']);
const IMAGE_MIME: Record<string, string> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	webp: 'image/webp',
};

export const TEXT_EXTENSIONS = [...TEXT_EXT];
export const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME);

export function extOf(name: string): string {
	const i = name.lastIndexOf('.');
	return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function kindOfName(name: string): Kind | null {
	const e = extOf(name);
	if (TEXT_EXT.has(e)) return 'text';
	if (e in IMAGE_MIME) return 'image';
	return null;
}

export function mimeFor(name: string): string {
	const e = extOf(name);
	return IMAGE_MIME[e] ?? 'text/plain';
}

const startsWith = (b: Uint8Array, sig: number[], off = 0) => sig.every((v, i) => b[off + i] === v);

export function matchesImageMagic(b: Uint8Array, ext: string): boolean {
	switch (IMAGE_MIME[ext]) {
		case 'image/jpeg':
			return startsWith(b, [0xff, 0xd8, 0xff]);
		case 'image/png':
			return startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		case 'image/gif':
			return startsWith(b, [0x47, 0x49, 0x46, 0x38]) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61;
		case 'image/webp':
			return startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8);
		default:
			return false;
	}
}

export function isValidUtf8(b: Uint8Array): boolean {
	try {
		new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b);
		return true;
	} catch {
		return false;
	}
}

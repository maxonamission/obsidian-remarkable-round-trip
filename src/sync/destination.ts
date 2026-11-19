/**
 * Where a send ended up, in words (GP_E5_S31).
 *
 * "Sent to reMarkable" did not say which folder. When a note landed in a
 * second "Obsidian" folder (GP_E5_S30), nothing pointed at it: the user saw
 * a success message and an unchanged folder. Naming the device folder makes
 * a wrong destination visible at once.
 *
 * Folder paths are device paths, "/"-separated; "" is the top level.
 */

export interface SentNote {
	/** The note's file name without folders, e.g. "Weeklog.md". */
	name: string;
	/** The device folder it was sent into ("" = top level). */
	folder: string;
}

function place(folder: string): string {
	return folder === "" ? "the top level of your reMarkable" : `${folder} on your reMarkable`;
}

/** The longest leading run of path segments every folder shares. */
function commonFolder(folders: readonly string[]): string {
	const split = folders.map((folder) => folder.split("/").filter(Boolean));
	const shared: string[] = [];
	for (let i = 0; i < Math.min(...split.map((parts) => parts.length)); i++) {
		const segment = split[0][i];
		if (split.every((parts) => parts[i] === segment)) shared.push(segment);
		else break;
	}
	return shared.join("/");
}

/** The opening sentence of a successful send's notice. */
export function describeSent(notes: readonly SentNote[]): string {
	if (notes.length === 0) return "Nothing new to send.";
	const folders = [...new Set(notes.map((note) => note.folder))];
	if (notes.length === 1) {
		return `Sent "${notes[0].name.replace(/\.md$/i, "")}" to ${place(folders[0])}.`;
	}
	if (folders.length === 1) return `Sent ${notes.length} notes to ${place(folders[0])}.`;
	const common = commonFolder(folders);
	return common === ""
		? `Sent ${notes.length} notes to ${folders.length} folders on your reMarkable.`
		: `Sent ${notes.length} notes to ${folders.length} folders under ${common} on your reMarkable.`;
}

/**
 * Subtle "what's changed" notice on version updates (GP_E5_S3), following the
 * shared pattern established in Voxtral Transcribe (VX_E2_S5): announce only
 * a real minor or major step forward, never a patch bump, and stay silent on
 * a fresh install. Pure module — the plugin edge owns the Notice and the
 * stored last-seen version.
 */

/** Parsed `major.minor.patch` — a `-suffix` (prerelease/build tag) is tolerated but ignored. */
interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
}

/** Matches "1.2.3" or "1.2.3-beta.1", capturing the three numeric components. */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/;

function parseVersion(version: string): ParsedVersion | null {
	const match = VERSION_RE.exec(version.trim());
	if (!match) return null;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
	};
}

/**
 * Whether a version bump from `prev` to `current` deserves the update notice:
 * true only for a real minor or major step forward. A patch bump, an equal
 * version, a downgrade, or an empty/unparseable version on either side all
 * return false — so a fresh install (no stored version yet) stays silent.
 */
export function shouldAnnounceUpdate(prev: string, current: string): boolean {
	const prevVersion = parseVersion(prev);
	const currentVersion = parseVersion(current);
	if (!prevVersion || !currentVersion) return false;

	if (currentVersion.major > prevVersion.major) return true;
	if (currentVersion.major === prevVersion.major) {
		return currentVersion.minor > prevVersion.minor;
	}
	return false;
}

/**
 * Read-only cloud diagnosis (GP_E3_S5).
 *
 * When the tablet reports a sync failure it is hard to tell *where* the
 * problem sits: in the cloud account, or in the device's local sync state.
 * This check reads — and only reads — the account's sync root and document
 * list, so a user without a laptop can tell those apart from their phone
 * instead of resorting to shell access on the tablet.
 *
 * Nothing here writes: no root update, no upload, no delete.
 */

import { MappingTable } from "../id/mapping";
import { adviseFailure, classifyFailure } from "./failure";

export interface DiagnoseApi {
	/** [rootHash, generation, schemaVersion] of the account's sync root. */
	getRootHash: () => Promise<[string, number, number]>;
	listItems: () => Promise<{ id: string; type: string }[]>;
}

export interface CloudDiagnosis {
	reachable: boolean;
	/** Generation counter of the sync root; rises with every change. */
	generation?: number;
	schemaVersion?: number;
	documentCount?: number;
	folderCount?: number;
	/** Documents we sent that are still present on the account. */
	mappedPresent?: number;
	/** Documents we sent that the account no longer has. */
	mappedMissing?: number;
	error?: string;
}

export async function diagnoseCloud(
	api: DiagnoseApi,
	table: MappingTable,
): Promise<CloudDiagnosis> {
	try {
		const [, generation, schemaVersion] = await api.getRootHash();
		const items = await api.listItems();
		const ids = new Set(items.map((item) => item.id));
		const mapped = Object.values(table);
		return {
			reachable: true,
			generation,
			schemaVersion,
			documentCount: items.filter((item) => item.type === "DocumentType").length,
			folderCount: items.filter((item) => item.type === "CollectionType").length,
			mappedPresent: mapped.filter((entry) => ids.has(entry.deviceDocId)).length,
			mappedMissing: mapped.filter((entry) => !ids.has(entry.deviceDocId)).length,
		};
	} catch (error) {
		return {
			reachable: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Human-readable verdict, aimed at someone holding only a phone. */
export function describeDiagnosis(diagnosis: CloudDiagnosis): string {
	if (!diagnosis.reachable) {
		const error = diagnosis.error ?? "unknown error";
		const advice = adviseFailure(classifyFailure(error));
		return (
			`Could not read your reMarkable cloud account (${error}). ` +
			(advice === ""
				? "That points at the connection or your pairing, not at the tablet itself."
				: advice)
		);
	}
	const lines = [
		"Your reMarkable cloud account is readable and consistent:",
		`• ${diagnosis.documentCount ?? 0} documents, ${diagnosis.folderCount ?? 0} folders`,
		`• sync root generation ${diagnosis.generation ?? "?"} (schema ${diagnosis.schemaVersion ?? "?"})`,
	];
	if ((diagnosis.mappedMissing ?? 0) > 0) {
		lines.push(
			`• ${diagnosis.mappedPresent ?? 0} of ${(diagnosis.mappedPresent ?? 0) + (diagnosis.mappedMissing ?? 0)} notes you sent are still on the account`,
		);
	}
	lines.push(
		"",
		"So the cloud side is fine. A sync error on the tablet is then local to " +
			"the device: restart it, and let it finish syncing before sending again.",
	);
	return lines.join("\n");
}

/**
 * Telling failures apart, so the message names the actual culprit (GP_E3_S10).
 *
 * Beta finding 2026-07-26: a DNS failure on the phone
 * ("UnknownHostException … No address associated with hostname") was reported
 * as "the connection or your pairing". Pairing had nothing to do with it, and
 * a wrong lead costs more time than no lead — the device never even got as far
 * as talking to reMarkable.
 */

/** What kind of thing went wrong, as far as the message lets us tell. */
export type FailureKind = "offline" | "auth" | "server" | "unknown";

const OFFLINE = [
	// Android/okhttp, the mobile path
	"unknownhostexception",
	"unable to resolve host",
	"no address associated",
	// Node/Electron and the browser stacks
	"enotfound",
	"eai_again",
	"err_name_not_resolved",
	"err_internet_disconnected",
	"err_address_unreachable",
	"err_connection_refused",
	"failed to fetch",
	"networkerror when attempting",
	"no internet",
];

const AUTH = ["401", "403", "unauthorized", "forbidden", "invalid token", "expired token"];

const SERVER = ["500", "502", "503", "504", "bad gateway", "service unavailable"];

function textOf(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).toLowerCase();
}

export function classifyFailure(error: unknown): FailureKind {
	const message = textOf(error);
	// Name resolution first: an offline device produces messages that also
	// contain the word "failed", which the other buckets would happily claim.
	if (OFFLINE.some((needle) => message.includes(needle))) return "offline";
	if (AUTH.some((needle) => message.includes(needle))) return "auth";
	if (SERVER.some((needle) => message.includes(needle))) return "server";
	return "unknown";
}

/**
 * What to do about it, in one sentence. Deliberately concrete: the reader is
 * usually holding a phone with no console and no laptop.
 */
export function adviseFailure(kind: FailureKind): string {
	switch (kind) {
		case "offline":
			return (
				"Your device could not look up the reMarkable server at all, so it never " +
				"reached them: this is a network problem, not your pairing. Check the " +
				"connection, and if it is up, check anything that intercepts DNS — a VPN, " +
				"private DNS, or an ad-blocking resolver."
			);
		case "auth":
			return (
				"The reMarkable cloud refused the credentials. Pair again in the plugin " +
				"settings with a fresh one-time code."
			);
		case "server":
			return "The reMarkable cloud itself returned an error. Nothing to fix here — try again later.";
		default:
			return "";
	}
}

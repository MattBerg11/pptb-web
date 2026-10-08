import { createHmac } from "node:crypto";
import { after } from "next/server";

/**
 * Sends PPTB events to the Discord bot (POST /pptb-events), which posts them to Discord.
 * The contract (body and signature) is defined by the bot in docs/PPTB_EVENTS.md.
 *
 * Needs DISCORD_EVENTS_URL (full URL, ending in /pptb-events) and PPTB_EVENTS_SECRET.
 * When either is missing, events are skipped quietly.
 */

type DiscordEvents = {
    // Revoked is not configured yet: nothing in pptb-web removes a submission, so it is never sent.
    toolSubmission: "New" | "Approved" | "Rejected" | "ChangesRequested" | "Revoked";
    tool: "UpdateCategories" | "Deprecated" | "Deleted" | "Update" | "ManualUpdate" | "UpdateFailed";
    verify: "Requested" | "Assigned" | "Approved" | "Rejected" | "Revoked";
};

type DiscordEventCategory = keyof DiscordEvents;

type DiscordEventBase = {
    /** Unique per event. The bot ignores an id it has already posted. Defaults to subject + event + time. */
    id?: string;
    subject: { type: "intake" | "tool" | "verification" | "toolUpdate"; id: string };
    tool: { id?: string; name: string; url?: string };
    developer?: string;
    actor?: string;
    reason?: string;
    detail?: Record<string, string>;
};

export type DiscordEvent = {
    [C in DiscordEventCategory]: DiscordEventBase & { category: C; event: DiscordEvents[C] };
}[DiscordEventCategory];

const TIMEOUT_MS = 10000;

export function toolPageUrl(toolId: string): string {
    return `${process.env.NEXT_PUBLIC_APP_URL || "https://www.powerplatformtoolbox.com"}/tools/${toolId}`;
}

/**
 * Queue a Discord notification to run after the response is sent.
 * Never throws and never delays or fails the request; problems are only logged.
 */
export function notifyDiscord(event: DiscordEvent): void {
    after(() => sendDiscordEvent(event));
}

async function sendDiscordEvent(event: DiscordEvent): Promise<void> {
    const url = process.env.DISCORD_EVENTS_URL;
    const secret = process.env.PPTB_EVENTS_SECRET;
    if (!url || !secret) return;

    const occurredAt = new Date();
    const { id, reason, ...rest } = event;
    const body = JSON.stringify({
        ...rest,
        id: id || `${event.subject.type}:${event.subject.id}:${event.event}:${occurredAt.getTime()}`,
        occurredAt: occurredAt.toISOString(),
        tool: { ...event.tool, name: event.tool.name.slice(0, 200) },
        reason: reason?.trim() ? reason.trim().slice(0, 1000) : undefined,
    });
    const timestamp = String(Math.floor(occurredAt.getTime() / 1000));
    const signature = "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-pptb-timestamp": timestamp, "x-pptb-signature": signature },
            body,
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
            console.warn(`[discord-events] ${event.category}.${event.event} was not posted (${response.status}): ${await response.text()}`);
        }
    } catch (error) {
        console.warn(`[discord-events] ${event.category}.${event.event} could not be sent:`, error);
    }
}

/**
 * Fixed, documented audit actors (tasks/todo.md T9, CP2 decision).
 * - ANONYMOUS: failed logins, whoever tried; the attempted identifier is stored only as a keyed hash.
 * - BOOTSTRAP: the `user:create-owner` CLI, before any user exists.
 */
export const ANONYMOUS_ACTOR_ID = '00000000-0000-7000-8000-000000000000';
export const BOOTSTRAP_ACTOR_ID = '00000000-0000-7000-8000-000000000001';

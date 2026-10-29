// The ES modules the page's scripts use. Scripts load after this one, so what is imported here is global for them.
import { DETAIL_BUTTONS, VOICE_HELP, createWakeGate, describe, interpret, isApproval, isCancel, isDictationEnd, ownerFrom, sourceFrom, toProjectName } from '/voice.js';
Object.assign(window, { DETAIL_BUTTONS, VOICE_HELP, createWakeGate, describe, interpret, isApproval, isCancel, isDictationEnd, ownerFrom, sourceFrom, toProjectName });
import { plausible, startMic } from '/mic.js';
Object.assign(window, { plausible, startMic });

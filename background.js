// State
let state = {
    tabId: null,
    targetId: null,
    targetAttached: false,
    breakpointId: null,
    gameScriptId: null,
    worldServicesReady: false,
    waitingForPause: false,
    initDone: false,
};

// Messaging to popup
function send(msg) {
    chrome.runtime.sendMessage(msg).catch(() => {});
}
function log(text, kind = "info") {
    send({ type: "LOG", payload: { text, kind } });
}

// CDP wrapper on the iframe target
function dbg(method, params = {}) {
    return new Promise((resolve, reject) => {
        chrome.debugger.sendCommand(
            { targetId: state.targetId },
            method,
            params,
            (res) => {
                if (chrome.runtime.lastError)
                    return reject(new Error(chrome.runtime.lastError.message));
                resolve(res);
            },
        );
    });
}

// CDP event listener
chrome.debugger.onEvent.addListener(async (source, method, params) => {
    // Debugger.paused -> capture worldServices
    if (
        source.targetId === state.targetId &&
        method === "Debugger.paused" &&
        state.waitingForPause
    ) {
        state.waitingForPause = false;
        log("Breakpoint triggered.", "success");

        const frames = params.callFrames;
        if (!frames || frames.length === 0) {
            log("No call frame available.", "error");
            await dbg("Debugger.resume").catch(() => {});
            send({ type: "INIT_FAIL", payload: "No call frame" });
            return;
        }

        try {
            const frameId = frames[0].callFrameId;

            const evalResult = await dbg("Debugger.evaluateOnCallFrame", {
                callFrameId: frameId,
                expression: `
            (function() {
                try {
                var ws = this.services;
                if (!ws)
                    return { ok: false, reason: "this.services is undefined" };
                window.__fmv_worldServices = ws;
                window.__fmv_giveInventoryItem = function(target, amount) {
                    try {
                    ws.rewardService.giveInventoryReward({
                        reward: { key: target, amount: amount },
                        parent: ws.mapGridView._view.parent.parent.parent
                    });
                        return { ok: true };
                    } catch(e) {
                        return { ok: false, reason: e.message };
                    }
                };
                return { ok: true };
                } catch(e) {
                return { ok: false, reason: e.message };
                }
            }).call(this)
            `,
                returnByValue: true,
            });

            const result = evalResult?.result?.value;

            if (result?.ok) {
                if (state.breakpointId) {
                    await dbg("Debugger.removeBreakpoint", {
                        breakpointId: state.breakpointId,
                    }).catch(() => {});
                    state.breakpointId = null;
                }
                state.worldServicesReady = true;
                log("Services captured successfully.", "success");
                send({ type: "INIT_DONE" });
            } else {
                log(
                    "Capture failed: " + (result?.reason || "unknown"),
                    "error",
                );
                send({ type: "INIT_FAIL", payload: result?.reason });
            }
        } catch (e) {
            log("Injection error: " + e.message, "error");
            send({ type: "INIT_FAIL", payload: e.message });
        }

        await dbg("Debugger.resume").catch(() => {});
        return;
    }

    // Debugger.scriptParsed -> detect game.g.*.js
    if (
        source.targetId === state.targetId &&
        method === "Debugger.scriptParsed" &&
        !state.gameScriptId
    ) {
        const url = params.url || "";
        if (url.includes("game.g.") && url.endsWith(".js")) {
            state.gameScriptId = params.scriptId;
            log("Game script detected: " + url.split("/").pop(), "info");
            await setGameBreakpoint();
        }
    }
});

chrome.debugger.onDetach.addListener((source) => {
    if (source.targetId !== state.targetId) return;

    state.targetAttached = false;
    state.worldServicesReady = false;
    state.breakpointId = null;
    state.waitingForPause = false;
    state.gameScriptId = null;
    state.initDone = false;

    log("Debugger detached. Please re-initialize.", "warn");
    send({ type: "DETACHED" });
});

// Breakpoint
async function setGameBreakpoint() {
    if (!state.gameScriptId || !state.targetAttached) return;
    if (state.breakpointId) return;

    try {
        log("Fetching game script source...", "info");
        const sourceRes = await dbg("Debugger.getScriptSource", {
            scriptId: state.gameScriptId,
        });

        const source = sourceRes?.scriptSource || "";
        if (!source) {
            log("Script source is empty or inaccessible.", "error");
            send({ type: "INIT_FAIL", payload: "Empty source" });
            return;
        }

        log(
            "Source loaded (" +
                Math.round(source.length / 1024) +
                " KB). Locating target pattern...",
            "info",
        );

        const PATTERNS = [
            "id']['hasCe",
            "'id']['hasCe",
            "mapGr'+'id']['hasCe",
            "'mapGr'",
        ];

        let col = -1;
        let usedPattern = "";

        for (const pat of PATTERNS) {
            let idx = source.lastIndexOf(pat);
            if (idx === -1) idx = source.indexOf(pat);
            if (idx !== -1) {
                col = idx;
                usedPattern = pat;
                break;
            }
        }

        if (col === -1) {
            log(
                "Target pattern not found. Falling back to line 0, col 0.",
                "warn",
            );
            col = 0;
        } else {
            log("Pattern found at column " + col + ".", "info");
        }

        const bp = await dbg("Debugger.setBreakpoint", {
            location: {
                scriptId: state.gameScriptId,
                lineNumber: 0,
                columnNumber: col,
            },
        });

        state.breakpointId = bp?.breakpointId;
        state.waitingForPause = true;
        log("Breakpoint set. Ready.", "success");
        send({ type: "INIT_DONE" });
    } catch (e) {
        log("Error setting breakpoint: " + e.message, "error");
        send({ type: "INIT_FAIL", payload: e.message });
    }
}

// Message handler
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
        switch (msg.type) {
            case "INIT": {
                try {
                    if (state.breakpointId && state.targetAttached) {
                        await dbg("Debugger.removeBreakpoint", {
                            breakpointId: state.breakpointId,
                        }).catch(() => {});
                    }
                    state.worldServicesReady = false;
                    state.breakpointId = null;
                    state.waitingForPause = false;
                    state.gameScriptId = null;
                    state.initDone = false;

                    const [tab] = await chrome.tabs.query({
                        active: true,
                        currentWindow: true,
                    });
                    if (!tab)
                        return sendResponse({
                            ok: false,
                            reason: "No active tab found.",
                        });
                    state.tabId = tab.id;

                    const allTargets = await new Promise((res) => {
                        chrome.debugger.getTargets((targets) =>
                            res(targets || []),
                        );
                    });

                    const gameTarget = allTargets.find(
                        (t) => t.url && t.url.includes("discordsays.com"),
                    );

                    if (!gameTarget) {
                        log(
                            "Game iframe not found. Make sure Farm Merge Valley is running on Discord.",
                            "error",
                        );
                        return sendResponse({
                            ok: false,
                            reason: "Game iframe not found.",
                        });
                    }

                    state.targetId = gameTarget.id;
                    log("Game target found.", "success");

                    if (!state.targetAttached) {
                        await new Promise((res, rej) => {
                            chrome.debugger.attach(
                                { targetId: state.targetId },
                                "1.3",
                                () => {
                                    if (chrome.runtime.lastError) {
                                        const m =
                                            chrome.runtime.lastError.message;
                                        if (m.includes("already")) {
                                            state.targetAttached = true;
                                            return res();
                                        }
                                        return rej(new Error(m));
                                    }
                                    state.targetAttached = true;
                                    res();
                                },
                            );
                        });
                        log("Debugger attached to game iframe.", "success");
                    }

                    await dbg("Runtime.enable");
                    await dbg("Debugger.enable");

                    await dbg("Runtime.evaluate", {
                        expression:
                            "Function.prototype.constructor = function() {};",
                    });
                    log(
                        "Function.prototype.constructor override injected.",
                        "info",
                    );

                    const perfResult = await dbg("Runtime.evaluate", {
                        expression: `
              (function() {
                try {
                  var e = performance.getEntriesByType("resource");
                  var s = e.find(function(r) {
                    return r.name.indexOf("game.g.") !== -1 && r.name.indexOf(".js") !== -1;
                  });
                  return s ? s.name : null;
                } catch(e) { return null; }
              })()
            `,
                        returnByValue: true,
                    });

                    const gameScriptUrl = perfResult?.result?.value;

                    if (gameScriptUrl) {
                        log(
                            "Game script located: " +
                                gameScriptUrl.split("/").pop(),
                            "info",
                        );

                        const bpTemp = await dbg(
                            "Debugger.setBreakpointByUrl",
                            {
                                url: gameScriptUrl,
                                lineNumber: 0,
                                columnNumber: 0,
                            },
                        ).catch((e) => {
                            log(
                                "Script ID resolution failed: " + e.message,
                                "warn",
                            );
                            return null;
                        });

                        const locs = bpTemp?.locations || [];
                        if (locs.length > 0 && locs[0].scriptId) {
                            const resolvedId = locs[0].scriptId;
                            if (bpTemp?.breakpointId) {
                                await dbg("Debugger.removeBreakpoint", {
                                    breakpointId: bpTemp.breakpointId,
                                }).catch(() => {});
                            }
                            if (!state.gameScriptId) {
                                state.gameScriptId = resolvedId;
                                await setGameBreakpoint();
                            }
                        } else {
                            log(
                                "Script ID not resolved. Waiting for scriptParsed event...",
                                "warn",
                            );
                        }
                    } else {
                        log(
                            "Game script not found via performance API. Waiting for scriptParsed event...",
                            "warn",
                        );
                    }

                    state.initDone = true;
                    sendResponse({ ok: true });
                } catch (e) {
                    log("Init error: " + e.message, "error");
                    sendResponse({ ok: false, reason: e.message });
                }
                break;
            }

            case "INJECT": {
                const { resource, amount } = msg.payload;
                if (!state.targetAttached) {
                    return sendResponse({
                        ok: false,
                        reason: "Not initialized.",
                    });
                }
                if (!state.worldServicesReady) {
                    return sendResponse({
                        ok: false,
                        reason: "Services not captured yet. Please re-initialize.",
                    });
                }
                try {
                    const result = await dbg("Runtime.evaluate", {
                        expression:
                            "window.__fmv_giveInventoryItem(" +
                            JSON.stringify(resource) +
                            ", " +
                            Number(amount) +
                            ")",
                        returnByValue: true,
                    });
                    const res = result?.result?.value;
                    if (res?.ok) {
                        sendResponse({ ok: true });
                    } else {
                        sendResponse({
                            ok: false,
                            reason: res?.reason || "Unknown error.",
                        });
                    }
                } catch (e) {
                    sendResponse({ ok: false, reason: e.message });
                }
                break;
            }

            case "GET_STATE": {
                sendResponse({
                    debuggerAttached: state.targetAttached,
                    worldServicesReady: state.worldServicesReady,
                    tabId: state.tabId,
                    targetId: state.targetId,
                });
                break;
            }

            case "CHECK_STATUS": {
                if (!state.targetAttached)
                    return sendResponse({ ready: false });
                try {
                    const r = await dbg("Runtime.evaluate", {
                        expression:
                            "!!(window.__fmv_worldServices && window.__fmv_giveInventoryItem)",
                        returnByValue: true,
                    });
                    const ready = r?.result?.value === true;
                    if (ready) state.worldServicesReady = true;
                    sendResponse({ ready });
                } catch (e) {
                    sendResponse({ ready: false });
                }
                break;
            }
        }
    })();
    return true;
});

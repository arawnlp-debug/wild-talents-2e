/* global HTMLElement, requestAnimationFrame */
// scripts/helpers/dialog-util.js
const { DialogV2 } = foundry.applications.api;

/**
 * Standard render handler fallback.
 */
export function wtRender(element) {
    if (!element) return;
    if (element instanceof HTMLElement) element.classList.add("wt-dialog-window");
}

/**
 * Standard cleanup function for closing dialogs safely.
 */
export function wtClose(d) {
    if (d && typeof d.close === 'function') {
        if (d.element) d.element.style.display = "none";
        d.close({ animate: false });
    }
}

/**
 * Immediately hides and destroys a dialog to prevent the "ghost window" artifact
 * where the parchment background lingers for a frame after content is cleared.
 * @param {ApplicationV2} app - The dialog application instance.
 */
function killDialog(app) {
    if (app?.element) app.element.style.display = "none";
    app.close({ animate: false });
}

/**
 * V14 COMPLIANCE FIX: Manual Promise Wrapper for DialogV2.
 * Bypasses the rigid configuration validation of DialogV2.wait() by instantiating natively 
 * and utilizing standard ApplicationV2 Event Listeners for DOM injection.
 */
export async function wtDialog(title, content, callback, options = {}) {
    const { defaultLabel = "Confirm", width = 400, buttons = null, render = null } = options;
    
    return new Promise((resolve) => {
        const finalButtons = buttons ? [...buttons] : [{
            action: "confirm", 
            label: defaultLabel, 
            default: true,
            callback: (e, b, d) => callback ? callback(e, b, d) : true
        }];

        let app = null;

        for (let btn of finalButtons) {
            const originalCallback = btn.callback;
            btn.callback = (e, b, d) => {
                try {
                    const result = originalCallback ? originalCallback(e, b, d) : true;
                    resolve(result);
                    // GHOST FIX: Hide the element immediately so the parchment
                    // background never flashes after the form content is cleared.
                    killDialog(d);
                    return false; // Prevent default V14 animated close
                } catch(err) {
                    console.error("WT Dialog | Button callback failed:", err);
                    resolve(null);
                }
            };
        }

        app = new DialogV2({
            classes: ["wt-dialog-window"],
            window: { title, resizable: true },
            position: { width, height: "auto" },
            content,
            buttons: finalButtons 
        });

        // GHOST FIX: Override close to always hide-then-destroy instantly.
        // This catches the 'X' header button, Escape key, and any other close path.
        const originalClose = app.close.bind(app);
        app.close = (closeOptions = {}) => {
            closeOptions.animate = false;
            if (app.element) app.element.style.display = "none";
            return originalClose(closeOptions);
        };

        app.addEventListener("close", () => resolve(null));

        app.addEventListener("render", (event) => {
            const el = app.element;
            if (!el) return;
            
            const f = el.querySelector("form");
            if (f) f.addEventListener("submit", ev => ev.preventDefault());
            
            if (typeof render === "function") {
                render({ target: { element: el } }, el);
            }
            
            // Recalculate height AFTER custom HTML injects, and enable scroll-y 
            // so tall forms never clip the bottom Confirm buttons.
            requestAnimationFrame(() => {
                if (app.rendered) {
                    app.setPosition({ height: "auto" });
                    const dialogContent = el.querySelector('.dialog-content');
                    if (dialogContent) {
                        dialogContent.style.overflowY = 'auto';
                        dialogContent.style.maxHeight = '75vh'; 
                    }
                }
            });
        });

        app.render({ force: true });
    });
}

export async function wtConfirm(title, content) {
    return await DialogV2.confirm({
        classes: ["wt-dialog-window"],
        window: { title },
        position: { height: "auto" },
        content: `<div class="wt-dialog-form">${content}</div>`,
        rejectClose: false
    });
}

export async function wtAlert(title, content) {
    return await DialogV2.prompt({
        classes: ["wt-dialog-window"],
        window: { title },
        position: { height: "auto" },
        content: `<div class="wt-dialog-form">${content}</div>`,
        rejectClose: false,
        ok: { label: "OK", callback: () => true }
    });
}
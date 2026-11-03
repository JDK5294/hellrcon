"use client";
/**
 * The screen area's safety net. Screens load on demand (their code is fetched the first time one
 * opens), so two things can now fail where the whole app used to be one file:
 *
 * - The panel is updated while a tab is open. That tab still asks for the old version's screen
 *   files, which are gone, and the screen cannot load. It reloads the page by itself — once; a
 *   second failure inside a minute stays on screen with a Reload button rather than looping.
 * - A screen crashes while drawing. Without a boundary React unmounts the whole app and leaves a
 *   blank page; with it the sidebar stays and only that screen says it failed.
 *
 * `resetKey` is where the viewer is — destination, tab and subject: going anywhere else clears the
 * failure. The destination alone was not enough: the failure replaces the whole screen area, the
 * hub's tab bar included, so a tab that failed could only be left by leaving its section — picking
 * another of its tabs in the sidebar kept the failure on screen.
 */
import { Component, type ReactNode } from "react";
import { isChunkLoadError, mayReload } from "../lib/chunkReload";

function safeSession(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

export class ScreenBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    if (isChunkLoadError(error) && mayReload(safeSession())) window.location.reload();
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="card stack" role="alert">
        <p className="hint notice" style={{ margin: 0 }}>
          {isChunkLoadError(error)
            ? "The panel was updated while this tab was open. Reload to get the new version."
            : "This screen hit an error and could not be shown. Reloading usually clears it."}
        </p>
        <div>
          <button type="button" className="primary" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}

# Feature Specification: IronCurtain Cinematic WebUI

## 1. Overview
The IronCurtain WebUI requires a high-impact, real-time visualization of its internal defensive AI agent loop. This feature serves a dual purpose: providing functional FSM state debugging for engineers while delivering a highly polished, "cyberpunk/Matrix" aesthetic for marketing, documentary b-roll, and open-source appeal.

## 2. Technical Stack
* **Frontend Framework:** Svelte 5 (using Runes `$state`, `$derived`, `$effect`).
* **Graph Layout:** Dagre (headless mathematical layout).
* **Foreground Render:** Native HTML/SVG driven by Svelte (no 3D libraries).
* **Background Render:** HTML5 `<canvas>` (2D API for high-performance particle/text rendering).
* **State Sync:** WebSocket JSON-RPC via the existing `WebEventBus`.

## 3. Core Architecture
The visualization is split into two strict Z-index layers to prevent DOM repaints from tanking framerates during heavy LLM token streaming.

### 3.1 Layer 1: The Data-Driven Matrix Rain (Background)
A full-bleed HTML5 Canvas element sitting behind the FSM. 
* **Aesthetic:** Phosphor green (`#00FF41`) or amber cascading characters over a deep black background.
* **Data Source:** Rather than random characters, the rain visually represents raw LLM token output or proxy intercept data (ingestion mechanism TBD via TLS MITM proxy).
* **The "Wake Up" Transition:**
    * *Idle State:* When no session is active, the rain occupies the screen at 100% opacity, serving as a screensaver.
    * *Active State:* Upon receiving a `session.start` or state transition event via the WebSocket, the canvas smoothly fades to 20% opacity. This pushes the rain into the background, allowing the FSM DAG to take focus.

### 3.2 Layer 2: The FSM DAG (Foreground)
The interactive state machine representing the IronCurtain workflow (e.g., *Orchestrator -> Discover -> Harness Design*).
* **Layout Math:** Dagre calculates X/Y coordinates invisibly. 
* **Nodes (HTML `div`):** Rendered as crisp, minimalist terminal-style boxes. 
* **Edges (SVG `path`):** Rendered as SVG lines connecting the calculated coordinates.

## 4. Visual Behaviors & Reactivity

### 4.1 State-Driven Node Pulsing
Svelte 5 reactivity will be tied directly to the `daemon.status` payload. 
* When a node's ID matches the `activeState` broadcasted by the WebSocket, Svelte applies an `.active` CSS class.
* This class triggers a CSS `@keyframes` animation, giving the node a slow, breathing neon border (emissive glow) to indicate the LLM is currently "thinking" in that state.

### 4.2 Edge Drawing Transitions
When the FSM transitions from State A to State B:
* Svelte's built-in `transition:draw` directive is applied to the SVG path connecting the two nodes.
* This creates a visual effect where the connecting line physically "draws" itself across the screen in real-time as the agent moves to the next step.

### 4.3 Strict Color Discipline
To ensure the UI remains legible and visually striking on camera:
* **Base Palette:** Strictly monochromatic (Dark greys, blacks, and phosphor green/amber).
* **The Highlight Trigger:** Critical action nodes (e.g., `Vulnerability Found`, `Exploit Blocked`) are assigned a harsh, contrasting highlight color (Electric Cyan or bright Crimson). This provides an immediate visual anchor when the defensive agent succeeds.

## 5. Integration with Existing `WebUiServer`
The feature relies entirely on the existing WebSocket infrastructure defined in `web-ui-server.ts`.

1.  **Subscription:** The Svelte SPA mounts and establishes the authenticated WebSocket connection.
2.  **Event Listening:** The frontend listens for JSON-RPC `EventFrame` payloads (specifically those emitted by the `WebEventBus` like `daemon.status` or specific `workflow.*` events).
3.  **State Hydration:** Svelte Runes consume the event payloads, automatically updating the active DAG node and triggering the necessary CSS transitions and Canvas opacity shifts.

## 6. Future Scope (Out of Bounds for Initial Implementation)
* **Telemetry Terminal:** The scrolling CLI interface for raw reasoning logs will remain a separate, standalone terminal process running on a secondary monitor.
* **Token Ingestion Pipeline:** The exact mechanism for routing live LLM tokens to the frontend `<canvas>` (e.g., via a proxy interposer) will be architected in a subsequent spec. Initial Canvas implementation will use simulated hex streams until the ingestion pipeline is built.

# Web-UI presentational combobox + portal popover (Svelte 5) + jsdom test gotchas

Context: `packages/web-ui/src/lib/components/features/model-combobox.svelte` — an
autocomplete input whose dropdown must escape a `max-h-[70vh] overflow-y-auto`
Modal without clipping. Layering rule (`packages/web-ui/CLAUDE.md:35`): `features/`
components MUST NOT import `stores.svelte.ts` — keep them presentational; the route
owns the fetch and passes data via props.

## Portal-to-body popover
- Portal via a Svelte action, NOT a component: `function portal(node){ document.body.appendChild(node); return { destroy: () => node.remove() }; }` applied `use:portal` on the `{#if open}` popover div. Testing-library `cleanup()` unmounts the component → runs the action's `destroy` → removes the body node. No leak.
- Position `fixed` against `input.getBoundingClientRect()`; reposition on `scroll` with **capture=true** (so scrolling a nested `overflow-y-auto` modal body repositions) + `resize`. z-index must beat the modal (modal is `z-50` → use `z-[60]`).
- Outside-close: `document.addEventListener('mousedown', ..., true)`; ignore when target is inside input or `popoverEl` (`.contains` works across the portal). Option rows use `onmousedown={e=>e.preventDefault()}` to keep focus on the input, then `onclick` commits.
- Escape when the popover is open must `e.stopPropagation()` so the enclosing Modal (which listens via bubbling `onkeydown` on its container) does not also close. When closed, let Escape bubble to close the modal.

## Two bugs that cost a test cycle each (jsdom)
- `CSS` is NOT a jsdom global → `CSS.escape(...)` throws "Cannot read properties of undefined (reading 'escape')". Avoid it: use `document.getElementById(id)` (portal is in body, so a document lookup finds it) instead of `popoverEl.querySelector('#'+escape(id))`.
- `Element.prototype.scrollIntoView` is absent in jsdom → `el.scrollIntoView is not a function` (an *unhandled rejection* if inside a `tick().then(...)`). Feature-detect: `if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView(...)`.
- `commit()` must NOT call `inputEl.focus()`. Focus never left the input (Enter doesn't blur; option mousedown is prevented), and a manual `.focus()` re-fires `onfocus`, which reopens the popover you just closed. Symptom: "popover closed after commit" assertion fails, DOM dump still shows the listbox.

## Test-mock contract when a route gains a new store action
- Add the new action to the existing `vi.mock('$lib/stores.svelte.js', () => ({...}))` block AND reset it in `beforeEach`, else the component throws when it calls the (undefined) action. Default it to a SAFE value so pre-existing save tests don't regress (here: `{ models: <all fixture slugs>, source: 'bundled' }` — bundled is warn-only, and the list covers every fixture slug).
- To assert an async load resolved before acting, key off a DOM signal that flips on load (e.g. a "bundled" badge that disappears when source becomes `live`) via `vi.waitFor(() => queryAllByTestId(...).length === 0)`, rather than guessing microtask ordering.
- `getAllByTestId(/^prefix-/)` accepts a RegExp — handy for `model-combobox-option-*` rows.

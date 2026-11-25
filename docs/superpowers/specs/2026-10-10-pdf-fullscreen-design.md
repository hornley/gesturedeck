# PDF fullscreen presentation design

## Goal

Show an imported PDF across the browser display while retaining page navigation through buttons and arrow keys. The built-in sample deck remains in the workspace view.

## Interaction

- Once a PDF has loaded, show an **Enter fullscreen** button beside the PDF import controls. Keep it hidden when no PDF is active.
- Activating the button requests browser fullscreen on the PDF display element. This requires a direct user action. The PDF page fits the available viewport without cropping, with a dark neutral background around pages whose aspect ratio differs from the screen.
- A compact bottom toolbar contains **Previous**, the current and total page numbers, **Next**, and **Exit fullscreen**. It appears on pointer movement and while any toolbar control has keyboard focus, then fades after a short idle period. It remains operable for pointer and keyboard users.
- The browser's Escape key and **Exit fullscreen** both return to the workspace. Restore focus to **Enter fullscreen** when the user exits through the toolbar or Escape.
- Replacing the PDF, returning to the sample deck, or leaving the page exits fullscreen and cleans up the previous PDF as the app already does.

## Implementation boundaries

Use the browser Fullscreen API on the existing PDF stage or its display wrapper, not a second PDF renderer. Reuse the current canvas and presentation controller. Add a dedicated fullscreen toolbar inside that element. Fullscreen layout styles expand the stage to the viewport and size the canvas to contain the current PDF page. A fullscreen change triggers a fresh render at the new bounds, and returning to the workspace rerenders at normal bounds. Keep the current render cancellation and import token protections.

## Errors and accessibility

- If the Fullscreen API is unavailable or the request fails, keep the PDF in the workspace and show a concise error near the fullscreen button.
- Toolbar buttons have accessible names, visible focus styles, and disabled states at page boundaries or while a page renders. Announce the page position through an appropriate live region without repeatedly announcing during resize renders.

## Verification

Manually load a multi-page PDF with mixed page orientations. Check entering fullscreen, fitting both orientations, button and arrow navigation, first and last page bounds, Escape and Exit, focus restoration, resize rendering, failed fullscreen requests, and returning to the sample deck. Existing PDF import and renderer behavior should remain intact.

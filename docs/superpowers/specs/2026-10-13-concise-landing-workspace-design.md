# Concise landing workspace design

## Goal

Make GestureDeck easier to start using by reducing the amount of explanatory text and keeping the primary presentation actions easy to find. The first screen remains the place where people choose and control their presentation; it is not a separate marketing page.

## Page structure and behavior

- Use a short heading and one-line description above the deck.
- Keep the sample deck canvas and previous/next controls as the primary content.
- Add a compact “Choose a deck” panel beside the canvas on wide screens, with actions to use the sample deck, open a PDF, and connect a phone.
- Keep errors and relevant session status visible when they occur. Remove repeated status and privacy explanations from the idle view.
- Keep the setup instructions short and focused on selecting a deck, presenting, and connecting a phone.

## Responsive and accessibility behavior

- On narrow screens, stack the launch panel below the deck and keep controls reachable without horizontal scrolling.
- Use semantic buttons and preserve visible keyboard focus, existing labels, live status announcements, and skip navigation.
- Keep all primary touch actions comfortably sized and spaced.
- Honor reduced-motion preferences for any new transitions.

## Validation

Review the initial idle view, sample deck controls, PDF import entry, phone pairing dialog, keyboard focus, and narrow-screen layout. Verify that the existing controls still target their current JavaScript handlers after the markup is reorganized.

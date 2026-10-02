# Design QA

**Final result: passed**

## Visual truth and capture

- Approved visual: docs/design/reference.png, the selected Academic Ledger proposal.
- Implementation: docs/design/desktop.jpg and docs/design/mobile.jpg, captured from the running local app in the Codex in-app browser.
- Desktop CSS viewport: 1487 × 1058; source PNG: 1487 × 1058; browser JPEG: 1472 × 1047; devicePixelRatio 1. Browser capture slightly reduces the image. Comparison coordinates were normalized by 1472/1487 horizontally and 1047/1058 vertically; raw image files are preserved. The common proportional comparison avoids findings caused by this capture scaling.
- Mobile CSS viewport: 390 × 844; full-page JPEG: 375 × 1660, capturing the document content width without the vertical scrollbar; devicePixelRatio 1.
- State: signed-in teacher, explicit demo mode, Sprint 2, Deliveries tab, counts/detail disclosure collapsed, no attendance records after CRUD cleanup.
- Live external credentials were not configured. These screenshots demonstrate local UI/API behavior, not verified Neon or Linear account integration.

## Comparison evidence

The source and desktop capture were opened together in one comparison input. Both retain the serif title and section headings, warm ivory surface, green navigation and actions, four muted chart colors, sprint selector, grouped student bars, and attendance section.

Focused inspection of the heading, legend, chart labels and attendance controls used the original-size images; their text was readable without additional crops. The corresponding UI was checked through the browser DOM for labels and values.

- **Typography:** Georgia approximates the approved serif headings; Arial supplies readable product UI text. Heading hierarchy and spacing match the reference direction. A closer font match is optional polish.
- **Layout rhythm:** header, title/selector row and histogram retain the selected hierarchy. Functional calculation text and a counts disclosure extend the chart slightly; all three student rows and the attendance action remain reachable.
- **Colors:** ivory background, forest green actions, muted green/amber/coral/rust bars reproduce the approved visual system.
- **Assets:** the reference consists of typography, chart graphics and letter avatars. There are no raster illustrations or photographic assets to recreate. The histogram uses Recharts rather than handcrafted SVG.
- **Copy/content:** attendance expands the mock's single total into the five user-approved categories. Demo badges and reset notice accurately describe the explicit demo. The empty attendance totals reflect the actual demo store after deletion, rather than copying synthetic source totals.

## Comparison history

1. First desktop capture: an oversized demo banner shifted the page hierarchy and pushed attendance rows below the reference frame (P2).
2. Fix: replace the banner with compact source-style Demo data badges and a footer reset notice. Reduce chart and table whitespace.
3. Post-fix evidence: docs/design/desktop.jpg. No remaining actionable P0/P1/P2 mismatch.
4. Mobile check: page width stays within the viewport; wide chart and attendance tables scroll inside their own regions. Added visible swipe instructions. The form remains a native, scrollable dialog with keyboard focus handling.

## Primary interactions checked

- Teacher login and authenticated data loading.
- Sprint 1/2 selection changes histogram counts.
- Accessible counts table: selecting Lara displays the six expected sample delivery tasks.
- Attendance save on desktop and mobile, category update without duplication, and delete confirmation followed by zero counts.
- Planning records display the presence-required policy without changing the selected category.
- Navigation between Deliveries and Attendance.
- Browser console inspection: no warnings or errors in the final rendered state.
- Mobile document width: 375 CSS pixels within a 390-pixel viewport (vertical scrollbar accounts for the difference).

## Follow-up polish and limits

- P3: Recharts omits zero-value bar labels; zeros remain available in the accessible counts table.
- P3: serif font, chart label sizing and fine spacing are close approximations rather than pixel-identical artwork.
- Neon writes, production rate-limit SQL and live Linear history reads require the user's environment variables. Production deployment remains unverified.

## Implementation checklist

- [x] Correct selected visual and functional states.
- [x] Desktop and mobile browser verification.
- [x] Authentication and attendance CRUD verified locally.
- [x] Build, lint, 30 tests and Prisma validation pass.
- [x] Node 24 build and tests pass.
- [x] No secrets in the frontend bundle.
- [x] Initial migration generated and preserved without applying it.

final result: passed

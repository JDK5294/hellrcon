/**
 * The public demo, at /demo: the panel itself, as an owner sees it, running on a made-up community
 * in the visitor's browser (components/DemoApp; nothing on it reaches this install). Shown only
 * while Administration → Online access has it on: the API answers 404 here otherwise.
 *
 * Not a client component, so the dark look is put on before the page paints (lib/demo/theme), as
 * the public stats site does its own.
 */
import DemoApp from "../../components/DemoApp";
import { DEMO_THEME_INIT_SCRIPT } from "../../lib/demo/theme";

export default function DemoPage() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: DEMO_THEME_INIT_SCRIPT }} />
      <DemoApp />
    </>
  );
}

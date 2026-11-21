import {
  Transition as HeadlessTransition,
  TransitionChild as HeadlessTransitionChild,
} from '@headlessui/react';
import type { ComponentProps } from 'react';

/**
 * Headless UI's Transition and TransitionChild, with each animated element
 * marked with what it animates (`data-animates="opacity transform"`).
 *
 * In the native app (`html.native-shell`, see globals.css) the mark turns
 * into `will-change`. WebKitGTK gives an element its own GPU layer when an
 * animation starts and can show that layer for one frame before painting
 * it: a sidebar or dialog that starts closing vanishes for a frame. With
 * `will-change` the layer exists, painted, before the animation. Browsers
 * don't get it, since `will-change` also affects fixed positioning and
 * backdrop blur inside the element.
 */
const TRANSFORM = /(^|[\s:-])(transform|translate|scale|rotate)/;

const animates = (props: Record<string, unknown>): string | undefined => {
  const classes = [
    props.enter,
    props.enterFrom,
    props.enterTo,
    props.leave,
    props.leaveFrom,
    props.leaveTo,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  const kinds = [
    classes.includes('opacity') ? 'opacity' : null,
    TRANSFORM.test(classes) ? 'transform' : null,
  ].filter(Boolean);
  return kinds.length > 0 ? kinds.join(' ') : undefined;
};

export const Transition = ((
  props: ComponentProps<typeof HeadlessTransition>
) => (
  <HeadlessTransition
    {...props}
    data-animates={animates(props as Record<string, unknown>)}
  />
)) as typeof HeadlessTransition;

export const TransitionChild = ((
  props: ComponentProps<typeof HeadlessTransitionChild>
) => (
  <HeadlessTransitionChild
    {...props}
    data-animates={animates(props as Record<string, unknown>)}
  />
)) as typeof HeadlessTransitionChild;

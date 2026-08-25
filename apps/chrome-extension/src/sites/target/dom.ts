import { ChannelAdapterError } from './wait';

export function requiredElement(
  root: ParentNode,
  selector: string,
  description: string,
): HTMLElement {
  const element = lookupElement(root, selector, description);
  if (element instanceof HTMLElement) return element;
  throw new ChannelAdapterError(
    'not-found',
    `${description} possui tipo incompatível no Channel.`,
  );
}

export function requiredInput(
  root: ParentNode,
  selector: string,
  description: string,
): HTMLInputElement {
  const element = lookupElement(root, selector, description);
  if (element instanceof HTMLInputElement) return element;
  throw new ChannelAdapterError(
    'not-found',
    `${description} não é um campo de texto no Channel.`,
  );
}

export function requiredSelect(
  root: ParentNode,
  selector: string,
  description: string,
): HTMLSelectElement {
  const element = lookupElement(root, selector, description);
  if (element instanceof HTMLSelectElement) return element;
  throw new ChannelAdapterError(
    'not-found',
    `${description} não é uma seleção no Channel.`,
  );
}

export function setInputValue(input: HTMLInputElement, value: string): void {
  input.value = value;
  dispatchValueEvents(input);
}

export function selectOptionByPrefix(
  select: HTMLSelectElement,
  prefix: string,
): HTMLOptionElement | undefined {
  const option = [...select.options].find((candidate) =>
    candidate.text.trim().startsWith(prefix),
  );
  if (!option) return undefined;

  select.selectedIndex = option.index;
  option.selected = true;
  option.click();
  dispatchValueEvents(select);
  return option;
}

export function selectExactOption(
  select: HTMLSelectElement,
  text: string,
): HTMLOptionElement | undefined {
  const option = [...select.options].find(
    (candidate) => candidate.text.trim() === text,
  );
  if (!option) return undefined;

  select.selectedIndex = option.index;
  option.selected = true;
  option.click();
  dispatchValueEvents(select);
  return option;
}

function dispatchValueEvents(
  element: HTMLInputElement | HTMLSelectElement,
): void {
  const EventConstructor = element.ownerDocument.defaultView?.Event ?? Event;
  element.dispatchEvent(new EventConstructor('input', { bubbles: true }));
  element.dispatchEvent(new EventConstructor('change', { bubbles: true }));
}

function lookupElement(
  root: ParentNode,
  selector: string,
  description: string,
): Element {
  const element = root.querySelector(selector);
  if (!element) {
    throw new ChannelAdapterError(
      'not-found',
      `${description} não encontrado no Channel.`,
    );
  }
  return element;
}

import L from 'leaflet';
import { describe, expect, it } from 'vitest';

import {
  bindElementTooltip,
  elementIcon,
  groupElement,
  setElementTooltip,
  textElement,
  withPersonColor,
} from './safe-dom';

const XSS = '<img src=x onerror=window.__xss=1>';

describe('safe-dom - the only Leaflet HTML sink wrapper (SPEC section 10.7.1)', () => {
  it('renders markup in names as text and creates no img element', () => {
    const element = textElement('span', XSS, { 'data-testid': 'area-tooltip', title: XSS });
    expect(element.textContent).toBe(XSS);
    expect(element.querySelector('img')).toBeNull();
    expect(element.getAttribute('title')).toBe(XSS);
    expect(element.getAttribute('data-testid')).toBe('area-tooltip');
  });

  it('refuses attributes that could run script or restyle', () => {
    expect(() => textElement('span', 'x', { onerror: 'alert(1)' })).toThrow('not allowed');
    expect(() => textElement('span', 'x', { style: 'color:red' })).toThrow('not allowed');
    const element = textElement('span', 'x', { hidden: undefined, 'aria-hidden': true, tabindex: 0 });
    expect(element.getAttribute('aria-hidden')).toBe('');
    expect(element.getAttribute('tabindex')).toBe('0');
  });

  it('builds chips from safe children and validates person colours', () => {
    const chip = withPersonColor(
      groupElement('div', [textElement('span', XSS)], { class: 'chip' }),
      '#c44f9d',
    );
    expect(chip.style.getPropertyValue('--c')).toBe('#c44f9d');
    expect(chip.querySelector('img')).toBeNull();
    const rejected = withPersonColor(textElement('span', 'x'), 'red;background:url(x)');
    expect(rejected.style.getPropertyValue('--c')).toBe('');
  });

  it('hands elements (never strings) to divIcon and tooltips', () => {
    const element = textElement('span', XSS);
    const icon = elementIcon(element, { iconSize: [10, 10] });
    expect(icon.options.html).toBe(element);
    expect(icon.options.className).toBe('snap-icon');
    const container = document.createElement('div');
    container.style.width = '100px';
    container.style.height = '100px';
    document.body.append(container);
    const map = L.map(container, { center: [32, 34.8], zoom: 10 });
    const marker = L.marker([32, 34.8]).addTo(map);
    bindElementTooltip(marker, element, { permanent: true });
    setElementTooltip(marker, textElement('span', 'plain'));
    expect(marker.getTooltip()?.getContent()).toBeInstanceOf(HTMLElement);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    map.remove();
    container.remove();
  });
});

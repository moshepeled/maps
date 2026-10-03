import { describe, expect, it } from 'vitest';

import { navigate, parseRoute } from './router';

describe('router (SPEC section 8.6, UX section 3.1)', () => {
  it('maps the three routes and treats unknown paths as the workspace', () => {
    expect(parseRoute('/signin', '').path).toBe('/signin');
    expect(parseRoute('/signup', '').path).toBe('/signup');
    expect(parseRoute('/', '').path).toBe('/');
    expect(parseRoute('/anything', '').path).toBe('/');
  });

  it('honours only local ?next= paths (no open redirects)', () => {
    expect(parseRoute('/signin', '?next=%2F').next).toBe('/');
    expect(parseRoute('/signin', '?next=%2F%3Farea%3D1').next).toBe('/?area=1');
    expect(parseRoute('/signin', '?next=%2F%2Fevil.example').next).toBe('/');
    expect(parseRoute('/signin', '?next=https%3A%2F%2Fevil.example').next).toBe('/');
    expect(parseRoute('/signin', '').next).toBe('/');
  });

  it('navigate pushes or replaces history entries', () => {
    const length = window.history.length;
    navigate('/signup');
    expect(window.location.pathname).toBe('/signup');
    expect(window.history.length).toBe(length + 1);
    navigate('/signin', { replace: true });
    expect(window.location.pathname).toBe('/signin');
    expect(window.history.length).toBe(length + 1);
    navigate('/signin', { replace: true });
    expect(window.history.length).toBe(length + 1);
  });
});

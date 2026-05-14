import { describe, expect, it } from 'vitest';
import { stripHtml } from '../utils/sanitize.js';

describe('stripHtml', () => {
  it('preserves normal text while removing markup', () => {
    expect(stripHtml('hello <strong>world</strong>')).toBe('hello world');
  });

  it('drops executable raw-text tag contents', () => {
    expect(stripHtml('safe<script>alert(1)</script><xmp><img src=x onerror=alert(1)></xmp>')).toBe(
      'safe'
    );
  });

  it('drops unterminated raw-text tags through the end of input', () => {
    expect(stripHtml('safe<style>body{display:none}')).toBe('safe');
  });
});

import { describe, expect, it } from 'vitest';
import { methodsOfView } from '../src/extract/endpoints/django.js';

describe('Django view decorator ownership', () => {
  it('reads the decorator attached to the requested function without crossing another definition', () => {
    const source = "@api_view(['POST'])\ndef create(): pass\n\n@api_view(['GET', 'GET'])\n@permission_classes([Public])\nasync def list_items(): pass\n";
    expect(methodsOfView(source, 'create')).toEqual(['POST']);
    expect(methodsOfView(source, 'list_items')).toEqual(['GET']);
  });

  it('does not transfer an unrelated decorator to an undecorated view', () => {
    expect(methodsOfView("@api_view(['GET'])\ndef list_items(): pass\ndef plain(): pass\n", 'plain')).toEqual([]);
  });
});

import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';

it('provides React Testing Library DOM matchers in jsdom', () => {
  render(<button type="button">Review</button>);

  expect(screen.getByRole('button', { name: 'Review' })).toBeInTheDocument();
});

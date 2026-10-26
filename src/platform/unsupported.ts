import type { Problem } from './detect.ts';

// Shows a full-page explanation instead of the scene. Built with DOM calls
// and textContent (not innerHTML) so no text can be interpreted as markup.
export function showProblem(container: HTMLElement, problem: Problem): void {
  const card = document.createElement('div');
  card.className = 'card';

  const title = document.createElement('h1');
  title.textContent = problem.title;

  const explanation = document.createElement('p');
  explanation.textContent = problem.explanation;

  const advice = document.createElement('ul');
  for (const line of problem.advice) {
    const item = document.createElement('li');
    item.textContent = line;
    advice.append(item);
  }

  const details = document.createElement('p');
  details.className = 'details';
  details.textContent = `Reason: ${problem.reason} · ${navigator.userAgent}`;

  card.append(title, explanation, advice, details);
  container.replaceChildren(card);
  container.hidden = false;
}

export function hideProblem(container: HTMLElement): void {
  container.hidden = true;
  container.replaceChildren();
}

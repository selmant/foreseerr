import './commands';

before(() => {
  if (Cypress.env('SEED_DATABASE')) {
    cy.exec('bun run cypress:prepare');
  }
});

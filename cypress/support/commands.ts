/// <reference types="cypress" />
import 'cy-mobile-commands';

Cypress.Commands.add('login', (email, password) => {
  cy.session(
    [email, password],
    () => {
      cy.request('POST', '/api/v1/auth/local', { email, password })
        .its('status')
        .should('eq', 200);
      cy.getCookie('connect.sid').should('exist');
      cy.visit('/');
      cy.location('pathname').should('not.eq', '/login');
    },
    {
      validate() {
        cy.request('/api/v1/auth/me').its('status').should('eq', 200);
      },
    }
  );
});

Cypress.Commands.add('loginAsAdmin', () => {
  cy.login(Cypress.env('ADMIN_EMAIL'), Cypress.env('ADMIN_PASSWORD'));
});

Cypress.Commands.add('loginAsUser', () => {
  cy.login(Cypress.env('USER_EMAIL'), Cypress.env('USER_PASSWORD'));
});

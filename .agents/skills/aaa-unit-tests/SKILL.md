---
name: aaa-unit-tests
description: >-
  Write clear, maintainable unit tests using the Arrange-Act-Assert (AAA)
  pattern. Use this skill when creating or refactoring unit tests. Written
  specifically for TypeScript/JavaScript, but high-level rules apply
  to all programming languages and frameworks.
license: MIT
metadata:
  author: 50BytesOfJohn
  version: "0.1.0"
---

# AAA Unit Tests

Use Arrange, Act, and Assert when writing unit tests.

## The pattern

1. Arrange - prepares everything the test needs.
2. Act - executes the action to test the code.
3. Assert - applies expectations to the result.

Always separate each step with a blank line and a comment. Sometimes, when tests are very simple and some steps can be written as one-liners, do it, and use a comment like "Act & Assert".

## Rules

1. **One behavior per test.** A test exercises a single Act. If you need two
   actions to make a point, write two tests.
2. **Name the test after the behavior.** Keep test names simple, understandable, and meaningful.
3. **Balance Arrange and shared setups.** Trust your intuition on duplication in Arrange versus shared setup. Sometimes shared setups are not worth it for shorter files or setups that vary per test. Move to shared logic only when the exact setup repeats and the test file grows bigger.
4. **Single expect per test.** Always use a single expect/assert per test. If you find yourself wanting to write more than one expect, rethink the entire test you're creating.
5. **No logic in tests.** Avoid loops, conditionals, and computation in the Act
   and Assert phases. Keep tests minimal.
6. **Assert on values, not implementation.** Verify observable results over
   internal calls; reserve mock-call assertions for genuine side effects.
7. **Test what really matters.** Never test constants, configuration, or any static hardcoded values. When code is using TypeScript, never write tests that verify something types already verify. Always test what really matters and what's testable.
8. **Test the unit.** You're writing unit tests, focusing strictly on units. These are not integration tests. You do not test multiple components working together. You test the most minimal unit that's testable in the code.
9. **YAGNI.** Keep tests YAGNI. Never add setup, helpers, or mocks for future use cases. Prepare and test for what's to test right now.
10. **Avoid over-testing.** Writing tests is very easy; make sure you do not write them for the sake of writing. Always think twice: Is this test needed? Is this test duplicate? Do I test the right thing?
11. **Validate, not guess.** It's important to properly understand the logic that you test. Whenever you have any doubt about the proper behavior of the code, always validate it with the user. Ask and clarify; that's a valid and proper approach.

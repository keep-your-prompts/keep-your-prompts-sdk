#include <kyp/kyp.hpp>

#include "check.hpp"

using kyp::render;

TEST(replaces_variables) {
  CHECK_EQ(render("Hello {{name}}, welcome to {{company}}.", {{"name", "Ada"}, {"company", "Acme"}}),
           "Hello Ada, welcome to Acme.");
}
TEST(spaces_inside_braces) {
  CHECK_EQ(render("[{{ name }}] [{{name }}] [{{  name}}] [{{\tname\t}}]", {{"name", "x"}}), "[x] [x] [x] [x]");
}
TEST(repeated_variable) { CHECK_EQ(render("{{a}}{{a}}-{{a}}", {{"a", "ab"}}), "abab-ab"); }
TEST(no_variables_is_identity) {
  CHECK_EQ(render("plain text, { single } braces }}", {}), "plain text, { single } braces }}");
}
TEST(missing_variable_throws_with_all_names) {
  try {
    render("{{a}} {{b}} {{a}} {{c}}", {{"b", "1"}});
    CHECK(false);
  } catch (const kyp::MissingVariable& e) {
    CHECK_EQ(e.names().size(), 2u);
    CHECK_EQ(e.names()[0], "a");
    CHECK_EQ(e.names()[1], "c");
    CHECK(std::string(e.what()).find("a, c") != std::string::npos);
  }
}
TEST(missing_variable_policies) {
  CHECK_EQ(render("x={{x}} y={{ y }}", {{"x", "1"}}, kyp::OnMissing::keep), "x=1 y={{ y }}");
  CHECK_EQ(render("x={{x}} y={{ y }}", {{"x", "1"}}, kyp::OnMissing::empty), "x=1 y=");
}
TEST(four_braces_render_literal_two) {
  CHECK_EQ(render("a {{{{ b", {}), "a {{ b");
  CHECK_EQ(render("{{{{name}}", {{"name", "x"}}), "{{name}}");
  CHECK_EQ(render("{{{{{{name}}", {{"name", "x"}}), "{{x");
  CHECK_EQ(render("Use {{{{var}} syntax, e.g. {{var}}", {{"var", "v"}}), "Use {{var}} syntax, e.g. v");
}
TEST(malformed_braces_are_text) {
  CHECK_EQ(render("{{ 1abc }} {{a-b}} {{}} {{name", {{"name", "x"}}), "{{ 1abc }} {{a-b}} {{}} {{name");
  CHECK_EQ(render("{{{name}}}", {{"name", "x"}}), "{{{name}}}");
}
TEST(values_are_not_rendered_again) {
  CHECK_EQ(render("{{a}}", {{"a", "{{b}}"}, {"b", "no"}}), "{{b}}");
}
TEST(utf8_passthrough) {
  CHECK_EQ(render("\xc2\xa1Hola {{n}}! \xe6\x97\xa5", {{"n", "Jos\xc3\xa9"}}), "\xc2\xa1Hola Jos\xc3\xa9! \xe6\x97\xa5");
}
TEST(variables_in_lists_distinct_names_in_order) {
  auto v = kyp::variables_in("{{b}} {{ a }} {{b}} {{{{c}} {{_d1}}");
  CHECK_EQ(v.size(), 3u);
  CHECK_EQ(v[0], "b");
  CHECK_EQ(v[1], "a");
  CHECK_EQ(v[2], "_d1");
}
TEST(prompt_render_member) {
  kyp::Prompt p;
  p.text = "Hi {{who}}";
  CHECK_EQ(p.render({{"who", "there"}}), "Hi there");
  CHECK_THROWS_AS(p.render({}), kyp::MissingVariable);
  CHECK_THROWS_AS(p.render({}), kyp::Error);
}

CHECK_MAIN

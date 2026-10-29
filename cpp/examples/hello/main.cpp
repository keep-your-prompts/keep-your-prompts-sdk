// The whole integration: read config from the environment, render a prompt.
//
//   export KYP_DELIVERY_KEY=kypd_...  KYP_APP=support-bot  KYP_ENV=prod
//   ./kyp-example-hello
#include <kyp/kyp.hpp>

#include <iostream>

int main() try {
  auto prompts = kyp::Client::from_env();

  std::string system_prompt = prompts.render("triage", {
      {"company", "Acme"},
      {"billing_queue", "refunds"},
  });

  std::cout << system_prompt << "\n";
  std::cout << "-- revision " << prompts.revision() << " from " << prompts.status().source << "\n";
} catch (const kyp::Error& e) {
  std::cerr << e.what() << "\n";
  return 1;
}

#include "../src/internal.hpp"
#include "check.hpp"

TEST(empty_string) {
  CHECK_EQ(kyp::sha256_hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
}
TEST(abc) {
  CHECK_EQ(kyp::sha256_hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}
TEST(two_blocks_448_bits) {
  CHECK_EQ(kyp::sha256_hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
           "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
}
TEST(fips_896_bits) {
  CHECK_EQ(kyp::sha256_hex("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu"),
           "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1");
}
TEST(quick_brown_fox) {
  CHECK_EQ(kyp::sha256_hex("The quick brown fox jumps over the lazy dog"),
           "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592");
}
TEST(one_million_a) {
  CHECK_EQ(kyp::sha256_hex(std::string(1000000, 'a')),
           "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
}
TEST(utf8_text) {
  // python3 -c 'import hashlib;print(hashlib.sha256("Prompts worth keeping. — ¿Sí? 日本".encode()).hexdigest())'
  CHECK_EQ(kyp::sha256_hex("Prompts worth keeping. \xe2\x80\x94 \xc2\xbfS\xc3\xad? \xe6\x97\xa5\xe6\x9c\xac"),
           "156940f9a7c7ed132e42313a107b9a256e2520e3d57befe4211fb931f1a48652");
}
TEST(incremental_matches_one_shot_at_every_boundary) {
  std::string data;
  for (int i = 0; i < 300; ++i) data.push_back(static_cast<char>('a' + i % 26));
  for (std::size_t len = 0; len <= data.size(); ++len) {
    for (std::size_t chunk : {1u, 3u, 63u, 64u, 65u}) {
      kyp::detail::Sha256 h;
      for (std::size_t i = 0; i < len; i += chunk) h.update(data.data() + i, std::min(chunk, len - i));
      CHECK_EQ(h.hex(), kyp::sha256_hex(std::string_view(data).substr(0, len)));
    }
  }
}

CHECK_MAIN

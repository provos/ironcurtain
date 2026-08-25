fn main() {
    let mut buffer = itoa::Buffer::new();
    print!("{}", buffer.format(37));
}

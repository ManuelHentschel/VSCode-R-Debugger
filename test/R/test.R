foo <- function(x, y) {
  print(x)
  print(y)
  x + y
}

bar <- function(x, n) {
  z <- x
  for (i in seq_len(n)) {
    print(i)
    z <- foo(z, x)
  }
  z
}

bar(2, 5)

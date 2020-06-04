foo <- function(x, y) {
  print(x)
  print(y); print(0)
  l <- list(1,2,3)
  lng <- length(l)
  x + y
  return(100)
} 

bar <- function(x, n) {
  z <- x
  for (i in seq_len(n)) {
    print(i)
    z <- foo(z, x)
  }
  z
}


f1 <- 100
fara <- 123
fuck <- 0
fantom <- FALSE
phantom <- TRUE
l <- list(a=1, b=2, c=3)

g <- function(){
  # asd
  print('g')
  return(list(1,2,333))
}

main <- function(){
  g()
}

# g()

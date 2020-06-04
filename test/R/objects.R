# NULL
nul <- NULL

# environment
env <- new.env()
env$a <- 1
env$b <- 1:5

# data.frame
df1 <- mtcars
df2 <- data.frame(id = 1:5, x = rnorm(5), y = rnorm(5))

# factor
fctr <- as.factor(c("a", "b", "c", "c", "d"))

# matrix
mat0 <- matrix(numeric())
mat1 <- matrix(1:10, nrow = 1)
mat2 <- matrix(1:10, ncol = 1)
mat3 <- matrix(rnorm(20), nrow = 4)

nmat1 <- matrix(1:10, nrow = 1, dimnames = list("x", letters[1:10]))
nmat2 <- matrix(1:10, ncol = 1, dimnames = list(letters[1:10], "x"))
nmat3 <- matrix(rnorm(20), nrow = 4, dimnames = list(letters[1:4], letters[1:5]))

# array
arr0 <- array(numeric())
arr1 <- array(1:10, c(10, 1, 1))
arr2 <- array(1:10, c(1, 10, 1))
arr3 <- array(1:10, c(1, 1, 10))

# list
lst0 <- list()
lst1 <- list(1:5, rnorm(5))
lst2 <- list(a = 1:5, b = rnorm(5), c = letters)
lst3 <- list(a = 1:5, b = rnorm(5), c = list(x = 1, y = 5:1))

# vector
v1 <- c(TRUE, TRUE, FALSE)
v2 <- rnorm(10)
v3 <- c("a", "b", "c")
v4 <- c(a = 1, b = 2)
v5 <- 1:10
v6 <- c(1 + 2i, 3 + 4i, 5 + 6i)
v7 <- charToRaw("hello")

# language
lang1 <- y ~ x + 1
lang2 <- ~ x - 1
lang3 <- quote(a + b * c)
lang4 <- alist(a = 1 + x + y, b = 3 * x * y^z)

# S3 class
lm_obj <- lm(mpg ~ ., data = mtcars)

# S4 class
setClass("Person", representation(name = "character", age = "numeric"))
setClass("Employee", representation(boss = "Person"), contains = "Person")
person <- new("Person", name = "Somebody", age = 20)

# function
fun1 <- sum # primitive
fun2 <- function(x, y) x + y
fun3 <- print # S3 method

# scalar
s1 <- 1
s2 <- 2L
s3 <- "a"
s4 <- 1 + 2i
s5 <- TRUE
s6 <- charToRaw("h")

main <- function() {
  print("testing objects")
  browser()
}
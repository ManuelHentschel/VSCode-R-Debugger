# options(vsc.trySilent = FALSE)

# options(error = traceback)

# options(vsc.doLogPrint = TRUE)

options(vsc.matricesByRow = FALSE)
options(vsc.dataFramesByRow = TRUE)

options(vsc.includeFrameColumn = FALSE)

# options(vsc.showInternalFrames = TRUE)

# options(vsc.showCustomAttributes = FALSE)
# options(vsc.showAttributes = FALSE)

options(vsc.groupAttributes = TRUE)

# trace(.vsc.setVariable, tracer=browser)

options(vsc.showUnclass = TRUE)

# NULL
nul <- NULL

# environment
env <- new.env()
env$a <- 1
env$b <- 1:5
env2 <- new.env()
env2$b <- 1000
assign('_a', 100, envir=env2)
attr(env2, 'a') <- 300
# l <- .vsc.getCustomInfo(env, 'childVars')

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
print(1)
arr0 <- array(numeric())

arr1 <- array(1:10, c(10, 1, 1))
arr2 <- array(1:10, c(1, 10, 1))
print(2)
arr3 <- array(1:10, c(1, 1, 10))
arr4 <- array(1:12, c(2,3,2))

# list
lst0 <- list()
lst1 <- list(1:5, rnorm(5))
lst2 <- list(a = 1:5, b = rnorm(5), c = letters)
lst3 <- list(a = 1:5, b = rnorm(5), c = list(x = 1, y = 5:1))
lst4 <- list(a = 1, a = 2, a = 3)
lst5 <- list(x=0,b=9,b=10,b=11,b=12)

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
person1 <- new("Person", name = "Somebody", age = 20)

# R6 class
Person <- R6::R6Class("Person",
  private = list(
    name = NULL,
    age = NULL
  ),
  public = list(
  initialize = function(name) {
    private$name <- name
  },
  greeting = function() {
    cat("Hello, my name is ", private$name, "!\n", sep = "")
  }
))
person2 <- Person$new(name = "Somebody")

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
s7 <- 'öé'

# ...
fun <- function(x, y=x, ...) {
  a <- 9
  print('2')
  # print('3')
  base::cat(list(1,2,3)) # error
  print('4')
  x*y
}

# active bindings
env1 <- new.env()
makeActiveBinding("x", function() rnorm(1), env1)

wait <- function(n){
  for(i in 1:(10^n)){
    i
  }
}

main <- function() {
  for(i in 1:8){
    print(i)
  }
  print('done')
}

#

f <- function(){
  print("'#")
}

"""Common first names, for redacting a personal name that has no cue word.

A regex cannot tell "Priya Nair" from "Circuit Breaker". A cue word ("customer
Priya Nair") and names learned from earlier emails cover most log lines, but a
line such as "Premium collection failed for Priya Nair" has neither. So: a
capitalised (or upper-case) word that is a known first name, followed by another
capitalised word, is treated as a person.

Deliberately conservative. Names that are also ordinary words or technical terms
(Will, Mark, Rose, Grace, Dev, Aurora, Nova...) are left out, because a
false positive destroys evidence ("Dev Environment") while a miss is bounded by
the other two mechanisms. The list is not exhaustive: a rare name with no cue and
no email is still a known limitation, asserted as such in the PII tests.
"""

from __future__ import annotations

FIRST_NAMES: frozenset[str] = frozenset("""
aarav aarti aakash aashish abhay abhijit abhilash abhinav abhishek aditi aditya ajay ajit akash akhil akshay alok amar
amit amita amrita anand ananya anil anirudh anita anjali ankit ankita ankur anmol anshul anup anupam anusha anushka
apoorva arjun arun aruna arvind asha ashish ashok ashwin atul avinash ayush bharat bhavna bhavya chandan chetan
darshan deepa deepak deepika devika dhruv dilip divya divyansh esha farhan farah gaurav gautam geeta girish gopal
gunjan gurpreet hardik harish harsh harsha hema hemant himanshu hitesh imran indira isha ishaan jagdish jaya jayesh
jayant jyoti kabir kailash kajal kamal kamala kanika karan karthik kavita kavya keshav kiran kishore komal krishna
kritika kunal lakshmi lalit lata lavanya madhav madhuri mahesh malini manish manisha manoj mansi meena meenakshi meera
mehul mihir mira mohan mohit mridul mukesh mukul nandini naveen navya neeraj neeta neha nidhi nikhil nikita nilesh
nirmala nisha nitin nitish   pallavi pankaj parth parul pooja poonam pradeep prakash pranav prashant pratik
preeti prem priya priyanka pulkit radha radhika rahul   rajat rajeev rajesh rajiv rakesh ramesh rashmi ravi ravindra
reema rekha renu riya rohan rohit rohini roshni ruchi rupa sachin sagar sahil sakshi salman sameer samir sandeep sandhya
sangeeta sanjay sanjana santosh sapna sarita saurabh shalini shankar sharad shashi shekhar shilpa shivani shreya
shubham shweta siddharth simran sneha sonal sonia soumya srinivas subhash sudhir sujata sumit sunil sunita suresh
surya sushma swati tanvi tanya tarun tushar uday uma umesh vaibhav vandana varun vasant vidya vijay vikas vikram
vinay vinod vipul virat vishal vivek yash yogesh zoya
oliver liam noah ethan mason logan lucas jacob jackson aiden emma olivia sophia isabella charlotte amelia harper
evelyn abigail emily elizabeth sofia mia ella madison scarlett victoria aria chloe penelope layla riley zoey nora
lily eleanor hannah lillian addison aubrey ellie stella natalie zoe leah hazel violet     audrey
  bella claire skylar lucy   everly anna caroline     emilia   maya   kinsley naomi
sarah allison gabriella madelyn cora eliana alice ruby piper ariana clara jonathan matthew daniel andrew joshua
christopher nathan brandon justin tyler kevin brian jason jeffrey timothy steven ryan gregory patrick raymond
samuel benjamin nicholas anthony
mohammed mohammad muhammad ahmed ahmad ali omar hassan hussain ibrahim yusuf fatima aisha zainab maryam khadija
sean patrick connor declan niamh siobhan aoife
wei jing li ming chen yuki hiroshi takeshi kenji akira sakura
""".split())

# Words that follow a first name in ordinary English and technical text; if the
# second word is one of these, it is not a surname.
NOT_A_SURNAME: frozenset[str] = frozenset("""
service server system pool queue cache database host node cluster manager engine gateway handler worker
error failure timeout exhausted exceeded connection request response policy premium payment account
""".split())

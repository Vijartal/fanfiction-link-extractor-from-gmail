# fanfiction-link-extractor-from-gmail
## google app scripts and optional chrome extension to extract links from emails in gmail.
### intended for use with **fanficfare** fanfiction downlaoder  https://github.com/JimmXinu/FanFicFare

currently the app script can grab links from emails from


in full useable form with app script only

**Fanfiction.net**  **archiveofourown.org**

with either some manual post processing or the chrome extension

**forums.spacebattles.com**  **forums.sufficientvelocity.com**  **forum.questionablequesting.com**

-- the emails have redirect links to indivual posts so you can just open them in a browser and either remove the excess part on the link page-num/post-num or press the page 1 button.
--- the extension does exactly that in a pop-up window then sends it back to the version of the script with added parts to receive it


# to use the script
1 have a label you put the alerts emails in that you want to work on

2 and a label you want them moved to when the link is pulled 
`you are advised to leave them until you finish just incase you need to go back and find one thats had issues there is also a script to go in reverse and add a label to a email that contains specific links "example i had was needing to fix the code for SB links as the few 9 digit "**post-ID**"s had the last digit cut off due to legacy issues from FF's 8 digit **ID**'s"`

3 in the scirpt add your labels in a format like "Label/Sub Label" `label will be as displayed not as searched in the webclient so "test 1 2 3" instead of "Test-1-2-3"`

4 name the **.TXT** files to be made in your google drive `you will need to delete them yourself afterwards including the one for the extension as i didnt feel comfortable automating that bit`

5 **optional -** if you use the extension and the newer version of the script you can automate getting the actual links from "SB SV QQ" <ins>you can also just grab a extension to mass open links and one to copy the links of all open tabs</ins>


# change log - only reliably starts from first published version/s
1.2 - added SB SV and QQ

1.25 fixed for 9 digit "**Post-ID**'s"

<ins>1.3 - **currently experimental version**</ins> added extension and changes to script work with it

##### code primarily made with chat-gpt due to lack of familiarity with the syntax this type of code and being a general amateur at coding beyond things like IF/AND/OR statements

